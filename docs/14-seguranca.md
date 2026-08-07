# 14 — Segurança

Este é o maior escopo do projeto, e também o mais denso em achados: além dos itens planejados no `TODO.md`, uma varredura de segurança revelou vários problemas que não estavam na lista original. Este documento cobre os dois grupos.

## Validação de payload em todos os endpoints

O `ValidationPipe` global já existia desde o Escopo 2 com `whitelist`/`forbidNonWhitelisted`. Este escopo fechou buracos específicos, cada um com uma história concreta por trás:

### `validationError: { target: false, value: false }`

Sem essa opção, quando o `class-validator` rejeita um payload, ele ecoa de volta **o corpo inteiro que foi rejeitado** dentro da mensagem de erro — senha em texto plano incluída, se a senha foi o campo que falhou a validação. Um vazamento de credencial causado pela própria mensagem de erro que deveria só informar "isso está errado".

### `@MaxLength(72)` na senha

`bcrypt` **ignora silenciosamente** qualquer byte além do 72º da senha (limitação conhecida do algoritmo, não um bug da lib usada aqui). Sem um teto explícito no DTO, duas senhas diferentes que compartilham os primeiros 72 bytes gerariam o mesmo hash — autenticando uma como se fosse a outra. `@MaxLength` no login também evita que alguém envie uma senha de vários megabytes só para forçar o servidor a gastar CPU rodando bcrypt sobre um payload gigante (um vetor barato de negação de serviço).

### `@Max(1_000_000_00)` em `TransferDto.amount`

`@IsInt()` sozinho aceita `1e21` — JavaScript, sob as regras do `Number`, considera isso um inteiro válido (é uma representação exata em ponto flutuante de um número inteiro, mesmo sendo absurdamente grande). Esse valor estourava o `BIGINT` do Postgres na hora de inserir, e o resultado era uma **500** genérica em vez de um 400 de validação claro — o tipo de erro que confunde tanto o cliente quanto quem está lendo o log de produção tentando entender por que uma transferência "quebrou o servidor".

### `@Max(500)` em `StatementQueryDto.page`

Antes desta correção, o extrato paginava fazendo `take: skip + pageSize` (buscando tudo até a página pedida e descartando o excesso em memória — um padrão de paginação ingênuo). Um `GET /wallets/me/statement?page=10000000`, vindo de qualquer usuário autenticado normal (não precisava de privilégio nenhum), virava um `take` de centenas de milhões de linhas — o suficiente para derrubar o Postgres com uma única requisição GET legítima em todos os outros aspectos.

### `ParseUUIDPipe` sistemático

Aplicado em todo parâmetro de rota que deveria ser um UUID (`/transactions/:id`, `/wallets/:id`, `/wallets/me/deposits/:id`) — rejeita valores malformados antes de qualquer query ao banco.

### Normalização de e-mail

```ts
// src/common/transforms/normalize-email.ts
@NormalizeEmail()   // decorator: trim + toLowerCase, aplicado no register, login e lookup
```

Sem isso, `Alice@x.com` e `alice@x.com` seriam duas contas distintas. O cenário concreto que motivou a correção: um atacante cadastra a variação homógrafa do e-mail de outra pessoa (`Vitima@X.com` quando a vítima real se cadastrou como `vitima@x.com`), e `GET /wallets/lookup?email=` — que resolve carteiras por e-mail para a tela de transferência (ver [`11-frontend.md`](./11-frontend.md)) — devolveria a carteira errada, sem normalização, para quem pesquisasse a variação. Um remetente de boa fé, confiando no e-mail exibido, pagaria o impostor.

## Proteção contra CSRF/XSS no frontend

A decisão central: **refresh token em cookie `httpOnly`, access token só em memória**. Manter tudo em `localStorage` (o estado anterior a este escopo) foi descartado deliberadamente. O raciocínio completo — os dois vetores de ataque, e por que cada defesa neutraliza um deles especificamente — está em [`00-conceitos-gerais.md`](./00-conceitos-gerais.md#por-que-o-refresh-token-vive-num-cookie-httponly-e-o-access-token-só-em-memória); a implementação está detalhada em [`03-autenticacao-jwt.md`](./03-autenticacao-jwt.md) (`refresh-cookie.ts`, `AuthController`) e [`11-frontend.md`](./11-frontend.md) (`token-store.ts`, `api-client.ts`).

Duas peças adicionais, do lado da infraestrutura:

- **CSP estrita no nginx** que serve o frontend (`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`) + `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`. `object-src 'none'`/`frame-ancestors 'none'` fecham, respectivamente, vetores de plugin legado e clickjacking (a página não pode ser embutida num `<iframe>` de outro site).
- **`helmet` no backend**, com `contentSecurityPolicy: false` (a CSP que protege de verdade é a do nginx, já que o backend só serve JSON — ver [`02-backend-estrutura-base.md`](./02-backend-estrutura-base.md)).
- **CORS deixou de ser aberto**: `app.enableCors({ origin: resolveCorsOrigins(configService), credentials: true })`, com `CORS_ORIGINS` como allowlist explícita (default: `FRONTEND_URL`). Isso não é opcional a partir do momento em que o cookie do refresh token existe: navegadores recusam `Access-Control-Allow-Origin: *` combinado com `credentials: true` — a lista **precisa** ser explícita, o que tem o benefício colateral de a API deixar de aceitar chamadas de qualquer origem.

## Rate limiting

`ThrottlerGuard` por rota/controller (nunca `APP_GUARD` global — ver a explicação em [`03-autenticacao-jwt.md`](./03-autenticacao-jwt.md)): transferência 20/min, criação de depósito 10/min, polling de depósito 60/min, lookup de e-mail 20/min, login 5/min, registro 10/min, refresh/logout 30/min.

Os dois buracos mais graves antes deste escopo: **transferência** sem limite significava que uma conta comprometida (senha vazada, sessão roubada) podia ser esvaziada em centenas de transferências pequenas antes de qualquer sistema de alerta reagir. **Registro** sem limite era um endpoint completamente anônimo rodando bcrypt (custo de CPU real) e escrevendo linhas no banco sem nenhum teto — um vetor barato de negação de serviço, ou de poluição de dados.

`skipIf: () => process.env.RATE_LIMIT_DISABLED === 'true'` — ligado só em `test/setup-e2e.ts`, nunca em produção — permite às suítes e2e (que registram dezenas de usuários em sequência) não colidir com o próprio limite que estão indiretamente testando.

## Ledger append-only {#ledger-append-only}

Detalhado a fundo em [`04-modelagem-de-dados.md`](./04-modelagem-de-dados.md#append-only-garantido-por-trigger-não-por-convenção) — resumo aqui: triggers `BEFORE UPDATE`/`BEFORE DELETE` em `transaction_entries` recusam qualquer alteração no nível do Postgres, com a única saída sendo a flag de sessão `app.ledger_maintenance`, usada exclusivamente pela limpeza de testes.

O achado que motivou isso, fora do texto original do escopo: depósitos creditavam `wallets.balance` sem gerar nenhum `LedgerEntry` correspondente. Numa auditoria de verdade, um saldo maior que a soma do razão é **indistinguível** de crédito fraudulento — não há como, olhando só os números, provar que a diferença é "legítima" (um depósito não registrado) e não um bug ou um ataque que inflou o saldo diretamente. A correção envolveu tornar `transactionId` opcional, introduzir `depositId`, um `CHECK` garantindo exatamente uma origem por lançamento, e fazer `DepositsService.confirmPaid` gravar o crédito no razão na mesma transação SQL do saldo (ver [`12-deposito-abacatepay.md`](./12-deposito-abacatepay.md)). Depósitos já pagos antes da migration foram *backfilled*.

## Sanitização de logs

`redact()` (`src/common/logging/redact.ts`), aplicado a **tudo** antes de sair pelo `JsonLoggerService`, em duas camadas:

```ts
const SENSITIVE_KEY_FRAGMENTS = ['password', 'senha', 'token', 'authorization', 'cookie', 'secret', 'apikey', 'cpf', 'cvv', ...];
```

Comparação por **substring** em minúsculas — não por nome exato de campo. Isso é deliberado: `refreshToken`, `x-api-key` e `user_password_hash` são todos capturados pelas mesmas poucas entradas da lista, sem precisar enumerar cada variação de nomenclatura (`camelCase`, `snake_case`, prefixos de header) separadamente.

```ts
const SENSITIVE_VALUE_PATTERNS = [
  { pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: REDACTED },          // JWT
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, replacement: `Bearer ${REDACTED}` },                   // header Authorization inteiro
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@]+@/gi, replacement: `$1:${REDACTED}@` },          // user:senha@host em connection strings
];
```

A segunda camada existe porque um segredo pode aparecer numa **string livre**, sem nenhum nome de campo para casar contra a primeira lista — o exemplo mais concreto é uma mensagem de erro do Prisma ou do `amqplib` que imprime a `DATABASE_URL`/`RABBITMQ_URL` **inteira**, credencial e tudo, quando a conexão falha. `redact()` varre qualquer string restante atrás desses padrões antes dela chegar ao log, independente de onde ela apareceu na estrutura do objeto.

```ts
if (value instanceof Error) {
  return { name: value.name, message: redactString(value.message), stack: value.stack ? redactString(value.stack) : undefined };
}
```

Achado lateral, mas relevante: `logger.error(exception)` sem esse tratamento especial serializava um objeto `Error` como `{}` — literalmente vazio, porque `JSON.stringify` de um `Error` nativo não inclui `message`/`stack` (eles não são propriedades enumeráveis próprias). Sem essa correção, todo `logger.error(err)` no sistema perdia silenciosamente a informação mais importante para depurar o próprio erro.

Referências circulares (`seen` via `WeakSet`) viram a string `'[Circular]'` em vez de fazer `JSON.stringify` estourar — um log nunca deveria conseguir derrubar o processo que ele está tentando observar.

Consequência direta em `HttpExceptionFilter`: erros não previstos (qualquer coisa que não seja uma `HttpException` do Nest — uma exceção crua do Prisma, por exemplo) **não são mais ecoados ao cliente**. O detalhe completo (que pode carregar SQL, nome de coluna, host do banco) vai inteiro para o log (já passando por `redact()`); o cliente recebe só `Internal server error`.

## Outros achados corrigidos neste escopo

Estes não estavam na lista original do `TODO.md` — surgiram de uma varredura de segurança deliberada ao final do desenvolvimento, e valem atenção especial porque são exatamente o tipo de problema que checklists genéricos de segurança não cobrem.

### `/admin/dlq` aberto a qualquer usuário logado — o mais grave

Antes: `/admin/dlq` e `/admin/dlq/replay` estavam protegidos só por `JwtAuthGuard` — qualquer conta, mesmo recém-criada, podia inspecionar a dead-letter queue **de todo o sistema** e, pior, chamar `replay` para reinjetar eventos de transação de terceiros na exchange principal.

```ts
// AdminGuard — src/auth/guards/admin.guard.ts
const admins = this.configService.get<string>('ADMIN_EMAILS', '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
if (!admins.includes(request.user.email.toLowerCase())) {
  throw new ForbiddenException('Acesso restrito a administradores');
}
```

Não existe conceito de "role" no modelo de dados deste projeto — inventar um só para isso seria expandir o escopo além do necessário. A lista de e-mails em configuração (`ADMIN_EMAILS`) resolve o problema imediato de forma proporcional. **`ADMIN_EMAILS` vazio significa que ninguém entra** — o padrão seguro por construção, ao contrário de uma lista vazia sendo interpretada como "sem restrição".

### `GET /api/metrics` sem autenticação

Expunha latências de transferência, taxa de erro, tamanho da DLQ e as métricas default do processo Node (versão, memória, event loop) — reconhecimento gratuito para quem estivesse mapeando a aplicação de fora, e um canal lateral sobre o volume real de transferências do sistema.

```ts
private matches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

`METRICS_TOKEN` opcional; quando configurado, exige `Authorization: Bearer <token>` comparado em **tempo constante** (`timingSafeEqual`, não `===`) — um `===` normal vazaria o token caractere a caractere para quem medisse cuidadosamente o tempo de resposta a tentativas com prefixos parcialmente corretos (o mesmo princípio do timing attack no login, abaixo). Vazio mantém o endpoint aberto por padrão, considerando que o scraper do Prometheus normalmente vive na rede interna — mas isso significa que expor esse endpoint publicamente sem configurar o token é uma escolha consciente, não um esquecimento coberto por padrão.

### Timing attack no login

Já detalhado em [`03-autenticacao-jwt.md`](./03-autenticacao-jwt.md#timing-attack-no-login): sem a correção, e-mail inexistente respondia quase instantaneamente (nenhum bcrypt rodava), e-mail existente com senha errada levava ~100ms (custo do bcrypt) — uma diferença mensurável o suficiente para enumerar quais e-mails têm conta na carteira, sem nenhuma credencial válida. Corrigido comparando sempre contra um hash descartável de mesmo custo quando o usuário não existe.

### Algoritmo do JWT não fixado

`algorithms: ['HS256']` tanto na assinatura quanto — mais criticamente — na **verificação** do refresh token e na estratégia Passport do access token. Sem fixar isso do lado da verificação, um token forjado anunciando um `alg` diferente no próprio header (uma classe histórica de vulnerabilidade em bibliotecas JWT) poderia, em tese, ser aceito por confiar cegamente no que o token diz sobre si mesmo.

### Segredos de placeholder indo para produção

Detalhado em [`02-backend-estrutura-base.md`](./02-backend-estrutura-base.md): em `NODE_ENV=production`, o boot **falha** se `JWT_*_SECRET` for um dos valores do `.env.example` ou tiver menos de 32 caracteres. Fora de produção, só um `Logger.warn` alto — suficientemente visível para não passar despercebido, sem travar o setup local de quem só copiou o `.env.example`.

### Depósitos pendentes sem limite

`MAX_PENDING_DEPOSITS_PER_WALLET = 5` — detalhado em [`12-deposito-abacatepay.md`](./12-deposito-abacatepay.md). Um problema de **acúmulo** (cada depósito cria objetos permanentes na conta AbacatePay que nunca são removidos), não de taxa — por isso o rate limit já existente (10/min) não era suficiente sozinho.

### Swagger em produção

`/api/docs` publicava o mapa completo da API — toda rota, todo DTO, toda regra de validação visível a qualquer um. Desligado por padrão em produção via `SWAGGER_ENABLED` (default: ligado fora de produção, desligado em produção).

### Container rodando como root

A imagem Docker do backend agora roda como `USER node` (uid 1000) — ver o Dockerfile em [`01-infraestrutura-local.md`](./01-infraestrutura-local.md). Rodar como root dentro de um container não é, por si só, uma falha crítica isolada, mas é um degrau a menos de dificuldade para qualquer um que consiga executar código dentro dele (via uma vulnerabilidade em alguma dependência, por exemplo) — remover esse degrau é uma correção de baixo custo e alto valor de defesa em profundidade.

## Correção posterior, a partir de uma falha de CI

O bug do unhandled rejection no `TransactionEventsConsumer` (canal do RabbitMQ caindo com uma mensagem em voo durante o shutdown) foi encontrado e corrigido **depois** do fechamento inicial deste escopo, a partir de uma falha real observada no CI — está detalhado por completo em [`08-rabbitmq-retry-dlq.md`](./08-rabbitmq-retry-dlq.md#o-detalhe-que-derrubou-o-ci-unhandled-rejection-no-shutdown), porque é fundamentalmente um problema de mensageria, não de segurança — mas vale registrar aqui como exemplo de que "escopo fechado" não significa "nunca mais revisitado": o processo de desenvolvimento deste projeto tratou falhas descobertas depois como parte do trabalho, não como algo a ignorar por já estar em outro escopo.

## Achado que fica em aberto (dado histórico, não bug do código atual)

Duas carteiras de teste manual (`test@gmail.com`, `test1@gmail.com`) têm saldo maior que a soma do razão — resquício do antigo `POST /wallets/me/deposit` (removido no Escopo 12), que incrementava o saldo sem gravar nenhum registro. Não há de onde reconstruir esses lançamentos especificamente (diferente dos depósitos via AbacatePay, que foram todos *backfilled* corretamente a partir dos próprios registros de `WalletDeposit`). O invariante `saldo == soma do razão` vale para **todo o restante do sistema, e para tudo que acontece a partir de agora** — essas duas contas são um artefato histórico isolado, não uma falha da garantia atual.

## Como validar

```bash
cd apps/backend
npm run test                         # redact, AdminGuard, MetricsTokenGuard, refresh-cookie, segredos fracos, timing do login, token-store
docker compose stop backend
npm run test:e2e -- security ledger-audit
docker compose up -d backend
```

`test/security.e2e-spec.ts`: cookie `httpOnly`/`SameSite`, rotação e logout via cookie, normalização de e-mail, limites de payload, 403 no admin sem `ADMIN_EMAILS` correspondente, 429 no login, headers do `helmet`. `test/ledger-audit.e2e-spec.ts`: `UPDATE`/`DELETE` bloqueados pela trigger, `CHECK` de origem exclusiva, a escotilha de manutenção funcionando só quando ligada explicitamente. Validado também com `docker compose up --build`: cookie `HttpOnly; SameSite=Strict` real na resposta, CORS recusando origem desconhecida, 429 na 5ª tentativa de login, CSP servida pelo nginx, `id` = uid 1000 dentro do container.
