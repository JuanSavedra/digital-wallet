# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

This is a stock Vite + React + TypeScript scaffold (`npm create vite@latest`) with no application code yet — `App.tsx` still contains the default template markup. Treat this as a greenfield digital wallet project: there is no existing architecture to preserve, so establish clear structure as real features are added rather than bolting onto the template.

## Commands

- `npm run dev` — start the Vite dev server with HMR
- `npm run build` — type-check via `tsc -b` then build for production with Vite
- `npm run lint` — run ESLint over the project
- `npm run preview` — preview the production build locally

There is no test runner configured yet. If tests are added, record the run/single-test commands here.

## Tooling notes

- TypeScript project uses project references: `tsconfig.json` points to `tsconfig.app.json` (app source) and `tsconfig.node.json` (Vite config). Run `tsc -b` (not plain `tsc`) so both projects are checked.
- ESLint config (`eslint.config.js`) is flat-config style with `typescript-eslint`, `eslint-plugin-react-hooks`, and `eslint-plugin-react-refresh` (Vite-mode). It uses the non-type-aware `tseslint.configs.recommended` — if type-aware lint rules are needed later, switch to `recommendedTypeChecked`/`strictTypeChecked` as noted in README.md.
- React 19 with `StrictMode` enabled in `src/main.tsx`.
