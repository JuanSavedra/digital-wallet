# 03 — Autenticação e autorização (JWT)

> Nota histórica: este escopo foi fechado em duas partes. A maior parte (register/login/refresh/logout/rate limit) veio logo após o Escopo 2; o guard de "dono da própria carteira" só pôde ser implementado depois do Escopo 4 dar entidades reais ao `WalletsModule`.

## O que o Escopo 3 pedia

Cadastro com senha hasheada, login emitindo access + refresh token, uma rota protegida de referência, endpoint de refresh com rotação, logout, rate limiting no login, e um guard de autorização "dono da carteira".

Se você ainda não leu [`00-conceitos-gerais.md`](./00-conceitos-gerais.md) (seções "JWT: access vs. refresh" e "Por que o refresh token vive num cookie httpOnly"), vale ler antes — este documento assume esses conceitos.

## Como foi resolvido

### Cadastro e hash de senha

`AuthService.register` (`apps/backend/src/auth/auth.service.ts`): verifica e-mail duplicado, hasheia a senha com `bcrypt` (10 salt rounds — um equilíbrio padrão entre custo computacional e tempo de resposta aceitável), cria o usuário e **já provisiona a carteira dele** na mesma chamada:

```ts
async register(email: string, password: string) {
  const existing = await this.usersService.findByEmail(email);
  if (existing) throw new ConflictException('E-mail já cadastrado');
  const passwordHash = await bcrypt.hash(password, PASSWORD_SALT_ROUNDS);
  const user = await this.usersService.create(email, passwordHash);
  await this.walletsService.createForUser(user.id);
  return { id: user.id, email: user.email };
}
```

Não existe endpoint separado de "criar carteira" no sistema — todo usuário tem exatamente uma, criada no mesmo momento do cadastro. Isso simplifica bastante a autorização em todo o resto da API: "a carteira do usuário logado" é sempre resolvível sem ambiguidade.

### Emissão de tokens

`issueTokens` gera os dois tokens com segredos e algoritmo distintos:

```ts
const accessToken = await this.jwtService.signAsync(accessPayload, {
  secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
  expiresIn: accessExpiresInSeconds,   // 15 min
  algorithm: JWT_ALGORITHM,             // 'HS256', fixado
});
```

Fixar `algorithm: 'HS256'` explicitamente (tanto ao assinar quanto — mais importante — ao **verificar**, com `algorithms: [JWT_ALGORITHM]`) não é redundante: bibliotecas JWT historicamente tiveram vulnerabilidades onde um token forjado anunciando `alg: none` ou trocando para um algoritmo assimétrico era aceito porque o verificador confiava no `alg` declarado no próprio header do token, em vez de exigir um algoritmo específico. Fixar o algoritmo do lado da verificação fecha essa classe de ataque.

O refresh token carrega um `jti` (JWT ID) gerado com `randomUUID()`, que vira a chave de uma allowlist no Redis:

```ts
const jti = randomUUID();
await this.redisService.set(`auth:refresh:${jti}`, userId, refreshExpiresInSeconds);
```

### Rotação single-use — por que allowlist, não blacklist

A abordagem mais comum para revogar JWT é uma **blacklist**: uma lista de tokens invalidados antes do prazo, consultada a cada verificação. Este projeto faz o oposto — uma **allowlist**: o token só é válido se sua chave `jti` existir no Redis, e usar o token consome (deleta) a chave antes de emitir o próximo par:

```ts
async refresh(refreshToken: string): Promise<AuthTokens> {
  const payload = this.verifyRefreshToken(refreshToken);
  const storedUserId = await this.redisService.get(`auth:refresh:${payload.jti}`);
  if (!storedUserId || storedUserId !== payload.sub) {
    throw new UnauthorizedException('Refresh token inválido ou já utilizado');
  }
  await this.redisService.del(`auth:refresh:${payload.jti}`);  // rotação
  ...
  return this.issueTokens(user.id, user.email);  // novo par, nova chave
}
```

Consequência direta: um refresh token só funciona **uma vez**. Se ele for reutilizado depois de já ter sido trocado por um novo par (sinal de vazamento — alguém copiou o token e está tentando usá-lo em paralelo com o dono legítimo), a chave já não existe no Redis e a tentativa é rejeitada com 401. Logout reaproveita exatamente essa mesma estrutura: deletar a chave é o "equivalente funcional" de uma blacklist, sem precisar manter uma tabela separada.

### Onde o refresh token realmente vive: cookie `httpOnly`

Desde o Escopo 14, `/auth/login` e `/auth/refresh` **não devolvem mais o refresh token no corpo da resposta** — só o access token:

```ts
private respondWithTokens(tokens: AuthTokens, response: Response): { accessToken: string } {
  setRefreshCookie(response, this.configService, tokens.refreshToken, this.authService.getRefreshTokenTtlMs());
  return { accessToken: tokens.accessToken };
}
```

`setRefreshCookie` (`src/auth/refresh-cookie.ts`) escreve um cookie com `httpOnly: true`, `sameSite: 'strict'` e `path: '/api/v1/auth'` (escopo restrito — nenhuma outra rota da API precisa dele, então não há razão para o navegador enviá-lo em toda requisição). `readRefreshToken` dá precedência ao cookie sobre um campo `refreshToken` no corpo, que continua existindo só como fallback para clientes sem cookie jar (curl, integrações, testes de API que chamam a API diretamente sem passar pelo navegador).

Este é um ponto de acoplamento direto com o frontend: como o refresh token não está mais acessível a JavaScript, `withCredentials: true` precisa estar habilitado em toda chamada axios para o cookie ser enviado — ver [`11-frontend.md`](./11-frontend.md).

### Timing attack no login

Achado durante o Escopo 14, documentado aqui porque é parte do fluxo de login: antes da correção, quando o e-mail não existia, `bcrypt.compare` nunca rodava — a resposta voltava quase instantaneamente. Quando o e-mail existia mas a senha estava errada, `bcrypt.compare` rodava (custo de ~100ms por causa dos salt rounds). Essa diferença de tempo é, por si só, um oráculo: um atacante consegue enumerar quais e-mails têm conta na carteira sem nenhuma credencial válida, só medindo o tempo de resposta do login.

A correção usa um hash descartável, pré-computado com o mesmo custo, para que a comparação sempre rode:

```ts
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-attack-placeholder', PASSWORD_SALT_ROUNDS);
...
const passwordMatches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
if (!user || !passwordMatches) throw new UnauthorizedException('Credenciais inválidas');
```

### Guards: autenticação vs. autorização

Duas camadas distintas, não confundir:

- **`JwtAuthGuard`** (via `JwtAccessStrategy`, `passport-jwt`) responde "quem é você" — extrai e valida o access token do header `Authorization: Bearer`. Aplicado em `GET /users/me` como rota protegida de referência, e em praticamente todo o resto da API a partir daqui.
- **`WalletOwnerGuard`** (`src/wallets/guards/`) responde "você pode acessar *este* recurso específico" — usa `WalletsService.assertOwnership` para checar se a carteira pedida na rota (`:id`) pertence ao usuário autenticado: 404 se a carteira não existe, 403 se existe mas é de outra pessoa. Aplicado em `GET /wallets/:id`.

`GET /wallets/me` não precisa desse guard: como resolve a carteira a partir do usuário autenticado (nunca de um `:id` na URL), não existe brecha de IDOR (*Insecure Direct Object Reference*) a fechar — não há id nenhum para um atacante manipular.

### Rate limiting só onde faz sentido, nunca global

```ts
@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  @Throttle({ default: { limit: 10, ttl: 60_000 } })  @Post('register')
  @Throttle({ default: { limit: 5,  ttl: 60_000 } })  @Post('login')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })  @Post('refresh')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })  @Post('logout')
```

O `ThrottlerGuard` é aplicado **por controller/rota**, nunca registrado globalmente como `APP_GUARD`. Isso não é estilo — é uma lição aprendida: uma tentativa anterior de registrar globalmente limitou *toda* rota da API, incluindo endpoints usados em sequência rápida pelos próprios testes e2e (que registram dezenas de usuários um atrás do outro) — as suítes começaram a falhar por 429 em vez de testar o que deveriam. `login` tem o limite mais agressivo (5/min) porque é o alvo natural de força bruta de senha; `register` ganhou um limite (10/min) só no Escopo 14, ao perceber que era um endpoint anônimo rodando bcrypt e escrevendo no banco sem nenhum limite.

## Como se conecta com o resto do sistema

- Todo endpoint autenticado da API (`WalletsController`, `TransactionsController`, `messaging/admin.controller.ts`) depende do `JwtAuthGuard` definido aqui.
- `AuthService.register` → `WalletsService.createForUser` é o único caminho de criação de carteira — ver [`04-modelagem-de-dados.md`](./04-modelagem-de-dados.md).
- O cookie `httpOnly` definido aqui é consumido do outro lado por `src/lib/api-client.ts` e `src/lib/token-store.ts` no frontend — ver [`11-frontend.md`](./11-frontend.md).
- A allowlist no Redis (`auth:refresh:<jti>`) usa a mesma infraestrutura de `RedisService` que o lock distribuído (Escopo 6) e o cache de saldo (Escopo 9) — três usos diferentes do mesmo Redis, sem se misturar (prefixos de chave distintos: `auth:refresh:`, `lock:wallet:`, `wallet:balance:`/`wallet:statement:`).

## Como validar

```bash
cd apps/backend
npm run test          # unitário (AuthService, guards)
docker compose up -d postgres redis rabbitmq
npm run test:e2e -- auth wallets   # e2e: register→login→rota protegida→refresh→reuso rejeitado→logout
```

Fluxo manual via `curl`: register → login (observar o `Set-Cookie: dw_refresh=...; HttpOnly; SameSite=Strict`) → `GET /api/v1/users/me` com o access token → `/auth/refresh` (reaproveitando o cookie do jar) → repetir o mesmo refresh token usado (deve dar 401) → `/auth/logout` → `/auth/refresh` pós-logout (deve dar 401).
