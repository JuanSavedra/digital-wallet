# 11 — Frontend (React + Vite)

## O que o Escopo 11 pedia

Consumir a API construída nos escopos anteriores: TanStack Query para estado de servidor, um axios client com interceptors de auth, as telas principais (login, cadastro, dashboard, extrato, transferência, detalhe de transação) atrás de `ProtectedRoute`, a busca de destinatário por e-mail, e o cuidado especial com a `Idempotency-Key` no fluxo de transferência.

Boa parte deste documento descreve como o frontend evoluiu junto com decisões de segurança do Escopo 14 (token store, cookie httpOnly) — porque essas mudanças reescreveram partes centrais do que este escopo originalmente entregou. O código mostrado aqui é o estado atual, não o estado "recém-Escopo-11".

## Como foi resolvido

### TanStack Query — estado de servidor, não estado de aplicação

Saldo, extrato e detalhe de transação são buscados via `useQuery`, nunca guardados manualmente em `useState`/context. A vantagem prática: cache automático entre componentes que pedem o mesmo dado, deduplicação de requisições simultâneas, e um mecanismo de invalidação explícito (`queryClient.invalidateQueries`) que dispara refetch sob demanda — usado logo após uma transferência bem-sucedida (ver `TransferPage` abaixo) para que o dashboard mostre o saldo atualizado sem esperar o usuário navegar manualmente.

### `api-client.ts` — a peça mais densa do frontend

```ts
export const api = axios.create({ baseURL: API_BASE_URL, withCredentials: true });
const refreshClient = axios.create({ baseURL: API_BASE_URL, withCredentials: true });
```

Duas instâncias axios, não uma. `refreshClient` existe só para chamar `/auth/refresh` — e não passa pelos interceptors de `api`. A razão fica clara ao olhar o interceptor de resposta abaixo: se `refreshClient` usasse os mesmos interceptors, uma falha no próprio refresh tentaria disparar... outro refresh, num loop.

**`withCredentials: true` nas duas é obrigatório**, não um detalhe: desde que o refresh token passou a viver só num cookie `httpOnly` (Escopo 14), o navegador só anexa esse cookie a uma chamada cross-origin se a requisição pedir credenciais explicitamente — sem essa flag, `/auth/refresh` chegaria ao backend sem cookie nenhum, mesmo que ele exista no navegador.

Interceptor de request — injeta o access token em toda chamada:

```ts
api.interceptors.request.use((config) => {
  const accessToken = getAccessToken();
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});
```

Interceptor de resposta — a lógica de retry em 401:

```ts
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const isAuthEndpoint = originalRequest?.url?.startsWith('/auth/');

    if (error.response?.status === 401 && originalRequest && !originalRequest._retry && !isAuthEndpoint) {
      originalRequest._retry = true;
      try {
        const newAccessToken = await sharedRefresh();
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return api(originalRequest);   // reexecuta a requisição original, uma vez
      } catch {
        markAnonymous();
      }
    }
    return Promise.reject(error);
  },
);
```

Três guardas importantes nessa condição: `!originalRequest._retry` (nunca tenta refresh duas vezes para a mesma requisição — evita loop infinito se o novo access token também vier a dar 401), `!isAuthEndpoint` (um 401 vindo do próprio `/auth/login` — senha errada — não deveria tentar "refresh"; é uma falha de credencial, não de token expirado) e a checagem de status exatamente `401`.

**Deduplicação de refreshes concorrentes** — o problema real que isso resolve: se o access token expira e o dashboard tem três `useQuery` em paralelo (saldo, extrato, algo mais), as três requisições batem 401 quase ao mesmo tempo. Sem coordenação, isso dispararia três chamadas simultâneas a `/auth/refresh` — e como o refresh **rotaciona** o token no backend (ver [`03-autenticacao-jwt.md`](./03-autenticacao-jwt.md)), a segunda e a terceira chamada tentariam usar um refresh token que a primeira já invalidou, falhando desnecessariamente.

```ts
let refreshPromise: Promise<string> | null = null;
function sharedRefresh(): Promise<string> {
  refreshPromise ??= refreshAccessToken().finally(() => { refreshPromise = null; });
  return refreshPromise;
}
```

Todas as chamadas concorrentes que chegam enquanto `refreshPromise` já existe reaproveitam a **mesma** Promise em andamento, em vez de disparar uma chamada de rede cada uma — só a primeira de fato chama `/auth/refresh`; as demais esperam o resultado dela.

### `token-store.ts` — por que o access token vive numa variável de módulo

```ts
let accessToken: string | null = null;
let status: AuthStatus = 'unknown';   // 'unknown' | 'authenticated' | 'anonymous'
```

Não é `useState` num componente React, nem `localStorage` — é uma variável de módulo comum, fora de qualquer componente. A razão é dupla: precisa ser lida tanto pelo React (`AuthContext`, via `useSyncExternalStore`) quanto pelos interceptors axios em `api-client.ts` (que não são componentes React e não podem chamar hooks) — uma única fonte de verdade acessível dos dois lados. E precisa **não** ser `localStorage`, porque `localStorage` é legível por qualquer script rodando na página — um XSS conseguiria roubar o token com uma linha de JavaScript. Uma variável de módulo desaparece ao recarregar a página, o que é exatamente o comportamento desejado para um token de 15 minutos.

**Estado inicial `unknown`, não `anonymous`** é o detalhe que evita um bug de UX real: como o access token não sobrevive a um F5, toda vez que a página recarrega o frontend começa sem saber se o usuário está logado — só o cookie de refresh (invisível a JS) sabe. Se o estado inicial fosse `anonymous`, `ProtectedRoute` redirecionaria para `/login` imediatamente, antes mesmo do `bootstrapSession()` (que troca o cookie por um access token novo) ter chance de rodar — todo F5 expulsaria o usuário logado. Com `unknown`, `ProtectedRoute` renderiza um estado de carregamento até o bootstrap terminar e só então decide.

```ts
export async function bootstrapSession(): Promise<void> {
  try {
    await sharedRefresh();
  } catch {
    markAnonymous();
  }
}
```

Chamado uma vez, no mount de `AuthProvider` — é literalmente um `/auth/refresh` "só com cookie", sem nenhum token no corpo, cujo único propósito é descobrir se existe uma sessão válida.

### `TransferPage` — o cuidado com `Idempotency-Key`

```ts
const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

const mutation = useMutation({
  mutationFn: async (amountCents) => {
    const destinationWalletId = await lookupWalletByEmail(recipientEmail.trim());
    return transfer(destinationWalletId, amountCents, idempotencyKey);
  },
  onSuccess: async (transaction) => {
    setIdempotencyKey(crypto.randomUUID());   // sucesso: chave nova pra próxima transferência
    ...
  },
  onError: (error) => {
    if (isAxiosError(error) && error.response) {
      setIdempotencyKey(crypto.randomUUID());   // erro DEFINITIVO do servidor: chave nova
    }
    // erro de REDE (error.response ausente): a chave NÃO muda, propositalmente
  },
});
```

Esta lógica espelha exatamente a máquina de estados do backend (ver [`05-idempotencia-transferencias.md`](./05-idempotencia-transferencias.md)) e é fácil de implementar ao contrário se você não tiver o backend em mente:

- **`error.response` ausente** (timeout, sem conexão, CORS bloqueado): o cliente não sabe se a requisição chegou a ser processada no servidor. A resposta correta é **reenviar com a mesma chave** — se a operação já tinha acontecido, o backend retorna a transação existente (`COMPLETED`) sem duplicar o débito; se não tinha acontecido, processa normalmente.
- **`error.response` presente** (o servidor respondeu, mesmo que com erro — ex.: 400 de saldo insuficiente, que marca a transação `FAILED`): reenviar a **mesma** chave seria sempre rejeitado com 409 pelo backend (ver a tabela de estados no doc do Escopo 5) — então a UI já gera uma chave nova, pronta para a próxima tentativa consciente do usuário.

O botão fica `disabled` durante `mutation.isPending`, prevenindo duplo-submit por clique duplo sem precisar de debounce — complementar à idempotência real (que protege contra reenvio via rede), não um substituto dela.

### Busca de destinatário por e-mail

`GET /wallets/lookup?email=` (backend, Escopo 10/11) existe porque, durante teste manual do fluxo de transferência, ficou claro que exigir o UUID cru da carteira do destinatário era uma experiência ruim — ninguém decora ou troca UUIDs como quem troca uma chave PIX ou um `@usuario`. `lookupWalletByEmail` resolve isso no frontend antes de chamar `transfer`, e o backend devolve só `{ walletId }` — nunca saldo ou qualquer outro dado do dono da carteira.

### CORS, do lado do frontend

O frontend em si não configura CORS (isso é responsabilidade do backend, `resolveCorsOrigins` em `setup-app.ts` — ver [`02-backend-estrutura-base.md`](./02-backend-estrutura-base.md)), mas depende diretamente dele: rodando em `:5173` (dev) ou `:8080` (Docker/nginx) contra uma API em `:3000`, toda chamada é cross-origin por definição. Sem a lista de origens permitidas no backend (com `credentials: true`, exigido pelo cookie httpOnly), o navegador bloquearia todas as respostas antes mesmo delas chegarem ao código React.

## Como se conecta com o resto do sistema

- Todo o desenho de `api-client.ts`/`token-store.ts` é a contraparte direta do Escopo 14 no backend (`AuthController`, `refresh-cookie.ts`) — ver [`03-autenticacao-jwt.md`](./03-autenticacao-jwt.md) e [`14-seguranca.md`](./14-seguranca.md).
- `TransferPage` consome `POST /transactions/transfer` (Escopo 5) e `GET /wallets/lookup` (Escopo 10).
- O Dashboard consome `POST /wallets/me/deposits` e faz polling de `GET /wallets/me/deposits/:id` — ver [`12-deposito-abacatepay.md`](./12-deposito-abacatepay.md).
- `TransactionDetailPage` faz polling (1s) enquanto `status === 'PENDING'` — hoje a conclusão da transferência é sempre síncrona no backend (nunca fica `PENDING` por mais que a duração da própria requisição), mas a tela já está pronta para o dia em que isso se tornar assíncrono de verdade.

## Como validar

```bash
cd apps/frontend
npm run build   # tsc -b (checa os dois tsconfig references) + build Vite
npm run lint
npm run test     # Vitest + Testing Library
```

Os testes de componente do fluxo de transferência cobrem especificamente: validação de valor inválido sem chamar a API, envio com a conversão reais→centavos correta e a `Idempotency-Key` exibida na tela, botão desabilitado durante o envio, e — o caso mais fácil de acertar ao contrário — reuso da mesma chave após um erro de rede simulado. Validação visual em navegador real é manual (não foi possível automatizar nesta sessão de desenvolvimento por falta de acesso a um navegador controlável).
