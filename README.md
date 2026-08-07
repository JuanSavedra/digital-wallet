# Digital Wallet

Sistema de carteira digital (transferências internas P2P, saldo, extrato e depósito via PIX) construído como um exercício de engenharia de sistemas distribuídos: consistência transacional, idempotência sob concorrência, mensageria assíncrona com garantias de entrega, cache com invalidação correta e uma superfície de segurança.

> Este README é voltado a quem está avaliando o código como sinal técnico. Para uma explicação didática, passo a passo, de como cada peça foi construída, veja [`docs/`](./docs).

## Stack

| Camada | Tecnologia | Motivo |
|---|---|---|
| Backend | NestJS + TypeScript | módulos, DI e interceptors alinhados com a separação de responsabilidades que o domínio exige (auth, wallets, outbox, messaging como módulos isolados) |
| Banco de dados | PostgreSQL | transações ACID reais para débito/crédito atômico, `CHECK` constraints e triggers a nível de banco |
| ORM | Prisma | migrations versionadas, `$transaction` multi-tabela |
| Cache / lock distribuído | Redis | cache-aside de saldo/extrato + lock distribuído por carteira |
| Mensageria | RabbitMQ | outbox pattern, retry com backoff exponencial, dead-letter queue |
| Frontend | React 19 + TypeScript (Vite) | SPA consumindo a API via TanStack Query |
| Autenticação | JWT (access + refresh) | access token stateless em memória; refresh token em cookie `httpOnly` com allowlist single-use no Redis |
| Gateway de pagamento | AbacatePay (PIX, dev mode) | depósito real de saldo via checkout hospedado, nunca dinheiro de verdade |
| Infra | Docker Compose | 5 serviços (`postgres`, `redis`, `rabbitmq`, `backend`, `frontend`), healthchecks, multi-stage builds |
| CI | GitHub Actions | lint + testes + build para os dois workspaces |

Todos os valores monetários são inteiros em centavos (`BigInt` no schema) — nunca ponto flutuante.

## Por que este projeto existe

Este projeto foi construído para responder às perguntas que eu tinha sobre concorrência, idempotência, mensageria e caching:

- **O que acontece se o cliente reenviar a mesma transferência duas vezes** (timeout de rede, duplo clique, retry automático)? → [Idempotência](./docs/05-idempotencia-transferencias.md)
- **O que acontece se duas transferências tentarem debitar a mesma carteira ao mesmo tempo**? → [Lock distribuído](./docs/06-lock-distribuido-redis.md) + lock otimista
- **Como garantir que um evento de "transferência concluída" só é publicado se a transferência realmente foi persistida** — sem um passo de commit distribuído entre Postgres e RabbitMQ? → [Outbox pattern](./docs/07-outbox-pattern.md)
- **O que acontece se o consumidor de eventos falhar ao processar uma mensagem**? Quantas vezes tentar, e o que fazer quando esgotar as tentativas? → [Retry + DLQ](./docs/08-rabbitmq-retry-dlq.md)
- **Como cachear saldo sem nunca mostrar um valor desatualizado logo após uma transferência**? → [Cache com invalidação por evento](./docs/09-cache-saldo-extrato-redis.md)
- **Como provar, depois do fato, que o saldo de uma carteira está correto** — sem confiar cegamente numa coluna `balance` que pode ter sido incrementada errado? → [Ledger append-only](./docs/14-seguranca.md#ledger-append-only)
- **Onde estão os buracos de segurança que checklists genéricos não cobrem** (timing attack no login, `Idempotency-Key` como superfície de ataque, admin endpoints sem guard, segredos de placeholder indo pra produção)? → [Segurança](./docs/14-seguranca.md)

## Arquitetura

### Fluxo de uma transferência ponta a ponta

```
Cliente             API             Redis               Postgres            RabbitMQ             Consumidor
  |  POST /transfer  |                |                    |                   |                     |
  |  Idempotency-Key |                |                    |                   |                     |
  |----------------->|                |                    |                   |                     |
  |                  | lock(walletA, walletB) ordem determinística             |                     |
  |                  |--------------->|                    |                   |                     |
  |                  |<---- OK -------|                    |                   |                     |
  |                  |                                     |                   |                     |
  |                  | BEGIN TX (Postgres)                 |                   |                     |
  |                  |------------------------------------>|                   |                     |
  |                  |   valida saldo, valida version (lock otimista)          |                     |
  |                  |   debita origem, credita destino    |                   |                     |
  |                  |   grava transaction_entries (ledger)|                   |                     |
  |                  |   grava transactions (status=COMPLETED, idem_key)       |                     | 
  |                  |   grava outbox_events (status=PENDING)  <- mesma TX     |                     |
  |                  | COMMIT                              |                   |                     |
  |                  |------------------------------------>|                   |                     |
  |                  | release lock   |                    |                   |                     |
  |<-- 201 Created --|                |                    |                   |                     |
  |  (síncrono, não espera a fila)    |                    |                   |                     |
  |                  |                |                    |                   |                     |
  |                  | [OutboxRelayService, a cada 2s, em paralelo]            |                     |
  |                  | lê outbox_events PENDING            |                   |                     |
  |                  |------------------------------------>|                   |                     |
  |                  |     publica "transaction.completed" (confirm channel)   |                     |
  |                  |-------------------------------------------------------->|                     |
  |                  |     marca outbox_events PUBLISHED   |                   |                     |
  |                  |------------------------------------>|                   |                     |
  |                  |                |                    |                   |  consome, dedupe    |
  |                  |                |                    |                   |  via Redis          |
  |                  |                |                    |                   |-------------------->|
  |                  |                |                    |                   |    invalida cache   |
  |                  |                |                    |                   |    saldo/extrato    |
  |                  |                |                    |                   |<--- ack/nack -------|
```

Pontos-chave:
- A resposta HTTP é **síncrona e não espera o RabbitMQ** — a API garante persistência ACID; o efeito colateral assíncrono (invalidação de cache) chega depois, tipicamente em milissegundos.
- O lock do Redis (`SET NX PX` + release condicional via Lua) protege a janela crítica sob concorrência e reduz retries; o lock otimista (coluna `wallets.version`) é quem garante a correção do saldo mesmo se o TTL do lock (5s) expirar no meio de uma operação lenta — nenhuma das duas camadas substitui a outra.
- O evento só entra na `outbox_events` porque o insert acontece **na mesma transação SQL** do débito/crédito — se o commit falhar, o evento nunca existiu, sem precisar de 2PC entre Postgres e RabbitMQ.

### Módulos do backend

```
apps/backend/src/
├── auth/          # JWT (access + refresh rotativo em allowlist Redis), guards, cookie httpOnly
├── users/         # rota autenticada de referência (GET /users/me)
├── wallets/       # saldo, extrato, lookup por e-mail, depósitos (AbacatePay), WalletOwnerGuard
├── transactions/  # transferência: idempotência + lock distribuído + lock otimista + outbox
├── ledger/        # skeleton — transaction_entries é escrito diretamente por TransactionsService
├── outbox/        # OutboxRelayService (publica), OutboxCleanupService (limpa PUBLISHED antigos)
├── messaging/      # RabbitMqService (confirm channel), TransactionEventsConsumer (retry/DLQ/dedupe), admin DLQ
├── cache/         # RedisService, RedisLockService (lock distribuído)
├── payments/      # AbacatePayService — cliente HTTP fino para a API v2
├── metrics/       # Prometheus, protegido por token opcional
├── common/        # HttpExceptionFilter, LoggingInterceptor, redact() de logs, normalize-email
├── config/        # validação de env vars via Joi, falha o boot se faltar algo obrigatório
└── prisma/        # PrismaService/PrismaModule (@Global)
```

### Modelo de dados

`User` 1—1 `Wallet` (uma carteira por usuário) → `Transaction` (transferências) e `WalletDeposit` (depósitos PIX) → ambos alimentam `LedgerEntry` (razão contábil imutável, `transaction_entries`), com um `CHECK` no banco garantindo que cada lançamento tenha **exatamente uma** origem (transação OU depósito, nunca as duas nem nenhuma). `OutboxEvent` é desacoplada por design — sem FK para `Transaction` — para ser reaproveitável por futuros agregados.

O ledger é **append-only de verdade**: triggers `BEFORE UPDATE`/`BEFORE DELETE` no Postgres rejeitam qualquer alteração, mesmo com acesso direto ao banco. A única exceção é uma flag de sessão usada exclusivamente pela limpeza de testes. `wallets.balance == SUM(transaction_entries)` é um invariante verificável a qualquer momento — não uma promessa de código de aplicação.

## Padrões de engenharia implementados

- **Outbox pattern** — publicação de eventos consistente com a transação de negócio, sem 2PC.
- **Idempotência via header `Idempotency-Key`** — com máquina de estados explícita para chave reutilizada (`COMPLETED` → retorna resultado anterior; `PENDING`/corrida → 409; `FAILED` → 409 pedindo nova chave) e tratamento de violação de constraint única do banco como sinal de corrida (não confia só em `SELECT` prévio).
- **Concorrência em duas camadas** — lock distribuído no Redis (latência/contenção) + lock otimista via coluna `version` (correção, mesmo se o Redis cair ou o TTL expirar).
- **Retry com backoff exponencial + DLQ** — contagem de tentativas em header próprio (não no `x-death` automático do RabbitMQ), fila "parking lot" com TTL por mensagem, DLQ com replay manual protegido por `AdminGuard`.
- **Idempotência no consumidor** — dedupe via Redis (`SET NX`) por id de evento, TTL 1h, liberado em caso de falha para não descartar uma retentativa legítima como duplicata.
- **Cache-aside com invalidação orientada a evento** — TTL de segurança + invalidação ativa disparada pelo mesmo consumidor de mensageria, só na página 1 do extrato (páginas mais antigas são imutáveis por natureza do ledger).
- **Ledger de dupla entrada append-only** — auditável independente da coluna de saldo, imutabilidade garantida por trigger de banco.
- **Refresh token rotativo single-use** — allowlist no Redis (não blacklist), `jti` deletado no uso; reuso é sempre rejeitado.
- **Defesa em profundidade contra XSS/CSRF** — access token só em memória (nunca `localStorage`), refresh token em cookie `HttpOnly; SameSite=Strict`, CSP estrita no nginx, CORS por allowlist explícita com credenciais.
- **Sanitização de logs em duas camadas** — mascara por nome de campo em qualquer profundidade *e* varre strings livres atrás de segredos embutidos (JWT, `Bearer …`, credenciais em connection strings do Prisma/amqplib).
- **Rate limiting por rota** (nunca global) e **validação de payload exaustiva** (`class-validator` com `@Max`/`@MaxLength` calibrados contra estouro de `BIGINT`, custo de bcrypt e paginação maliciosa).

Detalhe de cada um, com trechos de código e caminho de arquivo, em [`docs/`](./docs).

## Testes

| Suíte | Escopo |
|---|---|
| Backend unitário | 143 testes, 26 suítes — regras de negócio isoladas via mocks (Jest) |
| Backend e2e | 68 testes, 11 suítes — contra Postgres + Redis + RabbitMQ reais via `docker compose`, incluindo testes de **concorrência real** (`Promise.all` disparando requisições HTTP simultâneas contra a mesma carteira) |
| Frontend | Vitest + Testing Library — fluxo de transferência (validação, conversão reais→centavos, reuso de `Idempotency-Key` após erro de rede, botão desabilitado durante envio) |
| CI | GitHub Actions — lint + testes + build para os dois workspaces a cada push |

```bash
# backend
cd apps/backend
npm run test        # unitário, sem infra
docker compose stop backend && npm run test:e2e   # e2e, requer make up (ver abaixo)

# frontend
cd apps/frontend
npm run test
```

## Como rodar

```bash
cp .env.example .env
docker compose up --build
```

Sobe Postgres, Redis, RabbitMQ, backend (`:3000`, Swagger em `/api/docs`, migrations aplicadas automaticamente no start do container) e frontend (`:8080`). Alternativamente, `make up` / `make down` / `make logs` / `make ps` no root para gerenciar a stack, e `npm run dev` dentro de cada `apps/*` para desenvolvimento local com hot reload.

## Estrutura do repositório

```
.
├── apps/
│   ├── backend/    # NestJS — ver seção "Módulos do backend"
│   └── frontend/   # React + Vite — ver docs/11-frontend.md
├── docs/           # guia técnico passo a passo, por escopo de implementação
├── docker-compose.yml
├── Makefile
└── TODO.md         # planejamento original do projeto (histórico de decisões)
```

## Documentação técnica completa

O diretório [`docs/`](./docs) documenta cada etapa de construção do sistema — o que foi implementado, por que, como funciona internamente e como se conecta com as outras partes — na ordem em que o projeto foi de fato construído. Ponto de entrada: [`docs/README.md`](./docs/README.md).
