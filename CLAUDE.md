# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

This is a digital wallet project (internal transfers/payments) being built incrementally, scope by scope — see `TODO.md` (gitignored, local planning doc) for the full checklist and the suggested implementation order. Do not jump ahead to unimplemented scopes without confirming with the user first.

Monorepo layout:
- `apps/frontend` — React + TypeScript (Vite). Currently still the stock Vite template (`App.tsx` has default markup) — no wallet UI yet.
- `apps/backend` — NestJS + TypeScript. `AuthModule` and `UsersModule` have real logic (JWT auth, Prisma-backed users); `WalletsModule`, `TransactionsModule`, `LedgerModule`, `OutboxModule`, `MessagingModule` are still empty skeletons for later scopes. `PrismaModule` and `CacheModule` (Redis via `RedisService`) are `@Global()` — available everywhere without importing them explicitly. Prisma schema currently only has `User`; wallets/transactions/ledger/outbox tables are still pending (Scope 4).

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
