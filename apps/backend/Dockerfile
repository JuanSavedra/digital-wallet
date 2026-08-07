# --- deps: instala dependências (com devDependencies, necessárias para o build) ---
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# --- build: compila TypeScript -> dist ---
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- production deps: apenas dependências de runtime (inclui o CLI do
# prisma, necessário para "prisma migrate deploy" no start do container) ---
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

# --- runtime: imagem final, enxuta ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# `--chown` já entrega os arquivos ao usuário sem privilégio: a imagem do
# node traz um usuário `node` (uid 1000) e rodar como root num container é
# um degrau a menos para quem conseguir execução de código dentro dele.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --chown=node:node package.json ./

USER node

EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
