# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

This is a digital wallet project (internal transfers/payments) being built incrementally, scope by scope — see `TODO.md` (gitignored, local planning doc) for the full checklist and the suggested implementation order. Do not jump ahead to unimplemented scopes without confirming with the user first.

Monorepo layout:
- `apps/frontend` — React + TypeScript (Vite). Currently still the stock Vite template (`App.tsx` has default markup) — no wallet UI yet.
- `apps/backend` — NestJS + TypeScript. Not scaffolded yet (empty, next scope).

Infra (docker-compose at repo root) currently provisions Postgres, Redis, and RabbitMQ only. `backend`/`frontend` services will be added to `docker-compose.yml` once their Dockerfiles exist.

## Commands

Root (infrastructure):
- `make up` / `make down` / `make restart` / `make logs` / `make ps` — manage the docker-compose stack (Postgres, Redis, RabbitMQ)
- Copy `.env.example` to `.env` before running the stack

Frontend (`apps/frontend`):
- `npm run dev` — start the Vite dev server with HMR
- `npm run build` — type-check via `tsc -b` then build for production with Vite
- `npm run lint` — run ESLint over the project
- `npm run preview` — preview the production build locally

Backend (`apps/backend`): not scaffolded yet — commands will be added here once NestJS is initialized.

There is no test runner configured yet. If tests are added, record the run/single-test commands here.

## Tooling notes

- Frontend TypeScript uses project references: `apps/frontend/tsconfig.json` points to `tsconfig.app.json` (app source) and `tsconfig.node.json` (Vite config). Run `tsc -b` (not plain `tsc`) so both projects are checked.
- ESLint config (`apps/frontend/eslint.config.js`) is flat-config style with `typescript-eslint`, `eslint-plugin-react-hooks`, and `eslint-plugin-react-refresh` (Vite-mode). It uses the non-type-aware `tseslint.configs.recommended` — if type-aware lint rules are needed later, switch to `recommendedTypeChecked`/`strictTypeChecked` as noted in `apps/frontend/README.md`.
- React 19 with `StrictMode` enabled in `apps/frontend/src/main.tsx`.
- Backend ORM decision: Prisma (see `TODO.md` Scope 0). Money values are stored as integers (cents), never floats.

## Working style for this project

- Implement strictly by scope, one at a time (per `TODO.md`), confirming before moving to the next — the user explicitly asked not to bundle many tasks together.
- Architecture decisions already closed for this project (do not re-litigate unless the user raises it): monorepo structure, Prisma as ORM, single currency (BRL), money as integer cents.
