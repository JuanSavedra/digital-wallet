# 02 — Backend: estrutura base (NestJS)

## O que o Escopo 2 pedia

Criar o esqueleto do projeto Nest em `apps/backend`, com os módulos que os próximos escopos vão preencher (`AuthModule`, `UsersModule`, `WalletsModule`, `TransactionsModule`, `LedgerModule`, `OutboxModule`, `MessagingModule`, `CacheModule`), mais a infraestrutura transversal que todo endpoint vai depender: configuração validada, tratamento de erro padronizado, logging estruturado com correlation id, documentação via Swagger, versionamento de URL.

Este escopo é sobre construir os "trilhos" antes de qualquer lógica de negócio andar sobre eles — decisões erradas aqui (ex.: validação de env vars frouxa, formato de erro inconsistente) se propagam para todos os escopos seguintes.

## Como foi resolvido

### Configuração validada no boot, não em runtime

`@nestjs/config` com `isGlobal: true` (disponível em qualquer módulo sem reimportar) e um schema Joi (`src/config/env.validation.ts`) que valida **todas** as variáveis de ambiente no momento em que `ConfigModule.forRoot` roda:

```ts
DATABASE_URL: Joi.string().uri().required(),
REDIS_URL: Joi.string().uri().required(),
RABBITMQ_URL: Joi.string().uri().required(),
JWT_ACCESS_SECRET: secretString,  // ver detalhe abaixo
```

A ideia é falhar rápido e alto: se faltar uma variável obrigatória, o processo não sobe — nem parcialmente, nem com um comportamento incorreto silencioso. É melhor um crash imediato no boot do que uma 500 confusa três semanas depois porque `RABBITMQ_URL` estava vazia.

**Detalhe que só faz sentido lendo o Escopo 14 (segurança) depois**: o schema já validava tamanho mínimo desde este escopo, mas ganhou uma regra condicional mais estrita: em `NODE_ENV=production`, os secrets de JWT precisam ter no mínimo 32 caracteres e não podem ser nenhum dos valores de placeholder do `.env.example` (`change-me-access` etc.) — via `Joi.string().min(32).invalid(...PLACEHOLDER_SECRETS)`. Fora de produção a regra é mais permissiva (para não travar o setup local de quem só copiou o `.env.example`), mas o boot emite um `Logger.warn` bem visível (`warnOnWeakSecrets`, em `src/setup-app.ts`) — o objetivo é que ninguém suba um ambiente sério com segredo fraco sem perceber.

Um ponto sutil que mordeu os testes e2e mais tarde: `ConfigModule.forRoot` valida e **congela** o ambiente no momento em que `AppModule` é importado, não quando o app é instanciado. Isso significa que variáveis de ambiente específicas de teste (`ADMIN_EMAILS`, `RATE_LIMIT_DISABLED`) precisam ser definidas no `setupFiles` do Jest (`test/setup-e2e.ts`), que roda antes de qualquer import — defini-las num `beforeAll` já seria tarde demais.

### `configureApp()` — um único lugar para tudo que é transversal

`src/setup-app.ts` centraliza tudo que precisa estar configurado igual entre o `main.ts` real e os testes e2e (que sobem uma instância própria do app via `Test.createTestingModule`):

```ts
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.use(helmet({ contentSecurityPolicy: false, ... }));
  app.use(cookieParser());
  app.enableCors({ origin: resolveCorsOrigins(configService), credentials: true, ... });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, ... }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());
}
```

Isso evita a classe de bug onde `main.ts` e os testes e2e divergem silenciosamente (ex.: um pipe configurado só num dos dois, e o teste passa mas a produção se comporta diferente). O prefixo global (`api`) combinado com versionamento por URI (`VersioningType.URI`, `defaultVersion: '1'`) é o que produz o padrão de rota usado em toda a API: `/api/v1/...`.

`contentSecurityPolicy: false` no `helmet()` do backend é intencional e não uma omissão: esta app só responde JSON, a CSP que protege de verdade é a servida pelo nginx do frontend (ver [`14-seguranca.md`](./14-seguranca.md)) — e a CSP default do `helmet` quebraria o Swagger UI, que carrega scripts inline.

### `HttpExceptionFilter` — formato de erro único

Um `ExceptionFilter` global (`src/common/filters/http-exception.filter.ts`) garante que toda resposta de erro da API tenha o mesmo formato, e que erros inesperados (qualquer coisa que não seja uma `HttpException` do Nest — ex.: uma exceção do Prisma) nunca vazem detalhes internos para o cliente. Esse comportamento ficou mais rígido no Escopo 14 (ver lá) depois que se percebeu que a mensagem de erro original podia carregar SQL, nome de coluna ou host do banco.

### `LoggingInterceptor` — correlation id de ponta a ponta

Todo request ganha um `x-request-id`: reaproveitado se o cliente já mandou um no header, gerado via `randomUUID()` caso contrário. O valor é ecoado de volta na resposta (`response.setHeader`) e propagado via `RequestContext` (um `AsyncLocalStorage`, `src/common/context/request-context.ts`) para que qualquer código chamado durante aquele request — mesmo camadas profundas de serviço — consiga recuperar o correlation id sem precisar recebê-lo como parâmetro explícito em cada função.

```ts
return new Observable((subscriber) =>
  RequestContext.run({ correlationId }, () =>
    next.handle().pipe(tap({ ... })).subscribe(subscriber),
  ),
);
```

O comentário no código é importante para entender por que o `subscribe` acontece *dentro* do `RequestContext.run`: `next.handle()` só cria o Observable (nada executa ainda); é o `.subscribe()` que de fato dispara o controller. Se o subscribe acontecesse fora do `run`, o controller e os services chamados por ele rodariam fora do contexto, e o correlation id se perderia antes de qualquer log deles conseguir lê-lo.

Esse correlation id atravessa bem mais que o request HTTP: o `OutboxRelayService` o inclui no payload do evento publicado (`correlationId: RequestContext.getCorrelationId()`, ver [`07-outbox-pattern.md`](./07-outbox-pattern.md)), permitindo reconstruir a jornada completa de uma transferência (HTTP → outbox → RabbitMQ → consumidor) com um único id.

### Documentação e versionamento

Swagger em `/api/docs` via `@nestjs/swagger` (desligável em produção desde o Escopo 14, `SWAGGER_ENABLED`). Versionamento de API via `VersioningType.URI` — a escolha de URI em vez de header (`Accept-Version`) foi por simplicidade de teste manual (`curl`/navegador) e clareza de log (a versão aparece na própria URL).

## Como se conecta com o resto do sistema

- `WalletsModule`, `TransactionsModule`, `AuthModule` etc. citados no `TODO.md` deste escopo começam como módulos Nest vazios — ganham conteúdo real nos Escopos 3-9.
- `ValidationPipe` global aqui é a base sobre a qual o Escopo 14 adiciona as regras mais específicas (`@MaxLength`, `@Max`, `validationError: { target: false, value: false }`) — ver [`14-seguranca.md`](./14-seguranca.md).
- `PrismaModule` e `CacheModule` são declarados `@Global()` (não fazem parte deste escopo em si, mas seguem o mesmo espírito de infraestrutura compartilhada) — disponíveis em qualquer módulo sem import explícito.

## Como validar

```bash
cd apps/backend
npm run test          # env.validation.spec.ts, http-exception.filter.spec.ts, logging.interceptor.spec.ts
npm run test:e2e      # test/app.e2e-spec.ts — bate na rota real /api/v1
```

Boot com variável obrigatória faltando (`unset DATABASE_URL && npm run start:dev`) deve falhar imediatamente com erro Joi legível, não um crash genérico mais adiante.
