# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

This is a digital wallet project (internal transfers/payments) being built incrementally, scope by scope — see `TODO.md` (gitignored, local planning doc) for the full checklist and the suggested implementation order. Do not jump ahead to unimplemented scopes without confirming with the user first.

Monorepo layout:
- `apps/frontend` — React + TypeScript (Vite). Currently still the stock Vite template (`App.tsx` has default markup) — no wallet UI yet.
- `apps/backend` — NestJS + TypeScript. `AuthModule`, `UsersModule`, `WalletsModule`, `TransactionsModule`, `OutboxModule`, and `MessagingModule` have real logic; `LedgerModule` is still an empty *Nest module* skeleton (the `LedgerEntry` table is written to directly by `TransactionsService`, no dedicated service yet). `PrismaModule` and `CacheModule` (Redis via `RedisService`) are `@Global()` — available everywhere without importing them explicitly.
- Outbox pattern: `TransactionsService` inserts the `OutboxEvent` row inside the same `prisma.$transaction` as the debit/credit/ledger writes — if the transfer rolls back, the event never existed. `OutboxRelayService` (`src/outbox/`, `@Interval` every 2s) is the only thing that actually publishes to RabbitMQ, via `RabbitMqService` (`src/messaging/`), which uses an amqplib **confirm channel** (`waitForConfirms()`) — the event is only marked `PUBLISHED` after the broker actually acks it. A failure publishing one event doesn't block the rest of the batch or crash the relay; the event just stays `PENDING` for the next tick. `OutboxCleanupService` deletes `PUBLISHED` events older than 7 days via a daily `@Cron`.
- RabbitMQ consumer side (`src/messaging/`): `TransactionEventsConsumer` consumes `transactions.process` (bound to `wallet.events`/`transaction.completed`) using a plain amqplib channel, not `@nestjs/microservices` — this was a deliberate choice to share the connection with the publisher and control retry headers directly. Retry is TTL-based: failed messages go to `transactions.process.retry` (a "parking lot" queue whose `x-dead-letter-exchange` points back at `wallet.events`) with an exponential-backoff `expiration` and an `x-retry-count` header **we set ourselves** (not RabbitMQ's automatic `x-death`). After `MAX_RETRY_ATTEMPTS` (3, i.e. 4 total attempts) it's moved to `transactions.process.dlq`. Consumer-side idempotency uses `RedisService.setIfNotExists` keyed by the event id (`processed:event:<id>`, 1h TTL) — the actual business action lives in `TransactionEventsHandler` (currently just logs; Scope 9's cache invalidation will extend it, without touching the retry/dedup machinery). `GET/POST /admin/dlq(/replay)` (behind `JwtAuthGuard` only — no admin-role concept exists) expose monitoring and manual reprocessing.
- **Shutdown ordering gotcha**: only `RabbitMqService.onModuleDestroy` closes the shared amqplib connection. `TransactionEventsConsumer` deliberately has no `onModuleDestroy` of its own — closing a channel after its parent connection already closed (a real risk, since sibling providers' `onModuleDestroy` order isn't guaranteed) hangs forever. If you add another service that opens its own channel off `RabbitMqService.getConnection()`, don't give it a shutdown hook that closes that channel independently.
- **Running e2e tests that touch RabbitMQ**: `docker compose stop backend` first. The always-running backend container has its own `TransactionEventsConsumer` bound to `transactions.process`; if it's up while `npm run test:e2e` boots another Nest app with its own consumer on the same queue, RabbitMQ round-robins deliveries between the two and the tests fail non-deterministically (this bit us in Scope 9). Restart the container (`docker compose up -d backend`) afterward.
- `GET /transactions/:id` (Scope 10): viewable by whoever participated in it (origin or destination wallet owner) — `TransactionsService.findByIdForUser` checks both, 403 for anyone else, 404 if it doesn't exist.
- Wallet balance/statement caching (`WalletsService`, Scope 9): cache-aside, `wallet:balance:{id}` (30s safety TTL) and `wallet:statement:{id}:page:{n}` (60s TTL). Only page 1 of the statement is actively invalidated on `transaction.completed` — deeper pages are backed by the immutable ledger and never change once written, so their TTL alone is enough. `GET /wallets/me/statement` and `GET /wallets/:id/statement` are new in this scope. Invalidation logic lives in `TransactionEventsHandler` (see the messaging bullet above) — it's the same handler, same retry/dedup guarantees, just doing real work now instead of only logging.
- `POST /transactions/transfer` requires an `Idempotency-Key` header (UUID). Concurrency safety is layered: `RedisLockService` (`src/cache/redis-lock.service.ts`) takes a distributed lock per wallet (`lock:wallet:{id}`, `SET NX PX` + Lua-scripted safe release, keys acquired in sorted order to avoid deadlock) around the whole transfer, and Postgres optimistic locking (`wallets.version`, checked inside a `prisma.$transaction`) remains underneath as the correctness backstop — it's what actually guarantees the balance even if the Redis lock's TTL (5s) expires mid-operation or Redis itself is unavailable. Don't remove the `version` check when touching this code just because the Redis lock is there.
- `ThrottlerGuard` is applied **only** on `POST /auth/login` (`@UseGuards(ThrottlerGuard)` + `@Throttle`), not globally via `APP_GUARD` — an earlier global registration accidentally rate-limited register/wallets/transfer too and broke e2e tests that create many users. If you add more throttled routes, apply the guard per-route/per-controller, not globally, unless you deliberately want every route throttled.
- Every user gets exactly one wallet, auto-created at registration (`AuthService.register` calls `WalletsService.createForUser`) — there is no separate "create wallet" endpoint. `WalletOwnerGuard` (`src/wallets/guards/`) protects `GET /wallets/:id` (404 if the wallet doesn't exist, 403 if it belongs to someone else); `GET /wallets/me` sidesteps the issue entirely by resolving the wallet from the authenticated user, never from a route param.
- Prisma schema (`apps/backend/prisma/schema.prisma`) has `User`, `Wallet` (one per user), `Transaction`, `LedgerEntry` (`transaction_entries` table — immutable double-entry ledger), `OutboxEvent`. Money fields (`balance`, `amount`) are `BigInt` (cents) — **`BigInt` does not `JSON.stringify` natively**, convert to `string` in response DTOs once wallet/transaction endpoints exist. DB-level `CHECK` constraints (non-negative balance, positive amounts) were hand-added to the migration SQL — Prisma's schema DSL can't generate `@@check` yet, so any future schema change touching these tables must re-add the check constraints manually in the generated migration before applying it.

Infra (docker-compose at repo root) provisions Postgres, Redis, RabbitMQ, `backend`, and `frontend` — the full stack runs with `docker compose up --build`. Backend connects to the other services by their compose service name (`postgres`, `redis`, `rabbitmq`), not `localhost` — see the `environment:` overrides on the `backend` service in `docker-compose.yml`.

## Commands

Root (infrastructure):
- `make up` / `make down` / `make restart` / `make logs` / `make ps` — manage the docker-compose stack (Postgres, Redis, RabbitMQ)
- Copy `.env.example` to `.env` before running the stack

Frontend (`apps/frontend`):
- `npm run dev` — start the Vite dev server with HMR
- `npm run build` — type-check via `tsc -b` then build for production with Vite
- `npm run lint` — run ESLint over the project
- `npm run preview` — preview the production build locally

Backend (`apps/backend`):
- `npm run start:dev` — start Nest in watch mode
- `npm run build` — compile via `nest build`
- `npm run lint` — ESLint with `--fix`
- `npm run test` — Jest unit tests (`*.spec.ts` next to the source file they cover); fully mocked, no real infra needed
- `npm run test:e2e` — Jest e2e tests (`test/*.e2e-spec.ts`); **requires live Postgres + Redis** (`make up` first) — `PrismaModule`/`CacheModule` are global and connect eagerly on app bootstrap, so there is no hermetic e2e mode anymore once persistence exists
- `npm run prisma:migrate` / `prisma:deploy` / `prisma:generate` / `prisma:studio` — all wrapped with `dotenv -e ../../.env` so Prisma CLI reads the repo-root `.env` instead of needing its own
- Reads env vars from the repo-root `.env` in dev (see `envFilePath` in `src/app.module.ts`) — copy `.env.example` at the repo root first
- Swagger UI at `/api/docs`; all routes are prefixed `/api/v1` (global prefix `api` + URI versioning, default version `1`)
- `configureApp()` in `src/setup-app.ts` holds the prefix/versioning/pipes/filters/interceptors setup shared between `main.ts` and the e2e tests — extend it there, not separately in both places
- Auth: access tokens are stateless JWTs (`JWT_ACCESS_SECRET`); refresh tokens are JWTs whose `jti` is tracked in Redis (`auth:refresh:<jti>` → userId, TTL = token validity) as a single-use allowlist — refreshing deletes the old key and issues a new pair (rotation), logout just deletes the key. There is no separate blacklist table/structure.
- `prisma` is a regular `dependency` (not devDependency) on purpose — the production image runs `prisma migrate deploy` on container start (see `Dockerfile` CMD), which needs the CLI at runtime.

Frontend has no test runner configured yet. If tests are added, record the run/single-test commands here.

## Tooling notes

- Frontend TypeScript uses project references: `apps/frontend/tsconfig.json` points to `tsconfig.app.json` (app source) and `tsconfig.node.json` (Vite config). Run `tsc -b` (not plain `tsc`) so both projects are checked.
- ESLint config (`apps/frontend/eslint.config.js`) is flat-config style with `typescript-eslint`, `eslint-plugin-react-hooks`, and `eslint-plugin-react-refresh` (Vite-mode). It uses the non-type-aware `tseslint.configs.recommended` — if type-aware lint rules are needed later, switch to `recommendedTypeChecked`/`strictTypeChecked` as noted in `apps/frontend/README.md`.
- React 19 with `StrictMode` enabled in `apps/frontend/src/main.tsx`.
- Backend ORM decision: Prisma (see `TODO.md` Scope 0). Money values are stored as integers (cents), never floats.

## Working style for this project

- Implement strictly by scope, one at a time (per `TODO.md`), confirming before moving to the next — the user explicitly asked not to bundle many tasks together.
- A scope is not done just because it runs locally via `npm`. Every scope must also: (1) be containerized — Dockerfile + service wired into `docker-compose.yml`, verified with an actual `docker compose up --build` — and (2) have unit tests for new logic, integration tests where components interact, and e2e tests when the change is API/UI-facing. Verify by actually running things, not just writing them.
- Architecture decisions already closed for this project (do not re-litigate unless the user raises it): monorepo structure, Prisma as ORM, single currency (BRL), money as integer cents.
