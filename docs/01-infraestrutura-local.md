# 01 — Infraestrutura local

## O que o Escopo 1 pedia

Segundo o `TODO.md`: um `docker-compose.yml` com Postgres, Redis, RabbitMQ (com painel de management), backend e frontend, todos com healthcheck; variáveis de ambiente via `.env`; scripts de conveniência via `Makefile`; e o repositório reorganizado em monorepo (`apps/frontend` + `apps/backend`).

Este é o primeiro escopo do projeto — antes dele não existe nem estrutura de pastas. A decisão de fazer infraestrutura **primeiro**, antes de qualquer linha de lógica de negócio, é deliberada: todo o resto do sistema depende de Postgres/Redis/RabbitMQ existirem e serem alcançáveis de forma previsível, tanto em desenvolvimento local quanto dentro do container do backend.

## Como foi resolvido

### `docker-compose.yml` — 5 serviços

```yaml
services:
  postgres:   # postgres:16-alpine
  redis:      # redis:7-alpine
  rabbitmq:   # rabbitmq:3-management-alpine (porta 15672 = painel web)
  backend:    # build ./apps/backend
  frontend:   # build ./apps/frontend
```

Cada um dos três serviços de infraestrutura (`postgres`, `redis`, `rabbitmq`) tem um `healthcheck` real (`pg_isready`, `redis-cli ping`, `rabbitmq-diagnostics ping`), e o `backend` declara `depends_on` com `condition: service_healthy` para os três. Isso resolve um problema clássico de `docker compose up`: sem `condition: service_healthy`, o Compose só espera o *container* iniciar, não o *processo dentro dele* ficar pronto para aceitar conexões — o backend subiria e falharia ao conectar no Postgres porque o Postgres ainda estava inicializando.

### Como o backend encontra os outros serviços

Dentro da rede interna do Compose, os serviços se resolvem pelo **nome do serviço**, não por `localhost`:

```yaml
# docker-compose.yml, serviço backend
environment:
  DATABASE_URL: postgresql://...@postgres:5432/...
  REDIS_URL: redis://redis:6379
  RABBITMQ_URL: amqp://...@rabbitmq:5672
```

Isso é diferente do `.env` usado para rodar o backend fora do Docker (`npm run start:dev` local), onde essas mesmas variáveis apontam para `localhost` — porque, nesse caso, o processo Node roda diretamente na máquina host, não dentro da rede do Compose. É um erro comum confundir os dois contextos; vale ter isso claro antes de mexer em qualquer variável de ambiente.

### `NODE_ENV=development` sobrescrito de propósito

```yaml
# docker-compose.yml
environment:
  # A imagem é buildada com NODE_ENV=production, mas ESTE stack é o
  # ambiente de desenvolvimento local. Sem este override o boot falha de
  # propósito: em produção os segredos de placeholder do .env.example são
  # recusados na validação de ambiente. Num deploy real, NÃO copie esta linha.
  NODE_ENV: development
```

Isso é um detalhe que só faz sentido depois de ler o [Escopo 14 (segurança)](./14-seguranca.md): a validação de ambiente do backend recusa o boot em produção se os segredos JWT ainda forem os valores de exemplo do `.env.example`. Como este `docker-compose.yml` é pensado para desenvolvimento local — onde ninguém vai gerar segredos reais só para testar a stack —, ele força `NODE_ENV=development` no serviço, mesmo a imagem Docker sendo compilada com `NODE_ENV=production` (dependências de produção, sem devDependencies). Um deploy real deve **remover** esse override.

### Dockerfiles multi-stage

**Backend** (`apps/backend/Dockerfile`), quatro estágios:

1. `deps` — instala todas as dependências (incluindo devDependencies, necessárias para compilar TypeScript)
2. `build` — copia o código e roda `npm run build` (`nest build`, gera `dist/`)
3. `prod-deps` — reinstala só dependências de produção (`npm ci --omit=dev`) — inclui o Prisma CLI, necessário em runtime para `prisma migrate deploy`
4. `runtime` — imagem final: só `node_modules` de produção + `dist/` + `prisma/` (schema e migrations), rodando como usuário `node` (uid 1000), nunca root

O `CMD` da imagem final roda as migrations automaticamente antes de subir o servidor:

```dockerfile
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
```

`prisma migrate deploy` (diferente de `prisma migrate dev`) só aplica migrations já commitadas — não gera novas, não pede confirmação interativa — o que o torna seguro para rodar automaticamente no start de um container em qualquer ambiente.

**Frontend** (`apps/frontend/Dockerfile`), dois estágios:

1. `build` — `npm ci` + `npm run build` (Vite gera o bundle estático em `dist/`)
2. `runtime` — `nginx:1.27-alpine` servindo esse bundle, com `nginx.conf` customizado (fallback de SPA para rotas do `react-router-dom`, e — desde o Escopo 14 — os headers de segurança como CSP)

### Monorepo e `Makefile`

O código do Vite, que originalmente vivia na raiz do repositório, foi movido para `apps/frontend/`, e o backend Nest foi criado do zero em `apps/backend/` — sem workspaces npm compartilhados entre os dois (cada `apps/*` tem seu próprio `package.json`/`package-lock.json` independente; o `package.json` da raiz só existe para rodar os dois em paralelo via `concurrently` em desenvolvimento local, fora do Docker).

O `Makefile` na raiz só encapsula comandos do Compose — não faz nada que `docker compose` sozinho não faça, existe por conveniência:

```makefile
up:      docker compose up -d
down:    docker compose down
restart: down up
logs:    docker compose logs -f
ps:      docker compose ps
```

## Como se conecta com o resto do sistema

Toda a documentação a partir daqui assume esta base: `apps/backend` e `apps/frontend` como workspaces independentes, os três serviços de infraestrutura acessíveis por nome de serviço dentro do Compose e por `localhost` fora dele, e `.env`/`.env.example` como o único lugar onde configuração sensível ou específica de ambiente deveria viver (nunca hardcoded no código).

Um detalhe que só aparece mais tarde, mas nasce aqui: o backend containerizado fica **sempre rodando** por padrão neste projeto (`restart: unless-stopped`). Isso tem uma consequência direta nos testes e2e de mensageria — ver a nota "Achado importante" em [`09-cache-saldo-extrato-redis.md`](./09-cache-saldo-extrato-redis.md) sobre por que é preciso parar o container antes de rodar `npm run test:e2e`.

## Como validar

```bash
cp .env.example .env
docker compose up --build
docker compose ps     # os 5 containers, postgres/redis/rabbitmq como "healthy"
```

Backend em `http://localhost:3000/api/docs` (Swagger), frontend em `http://localhost:8080`, painel do RabbitMQ em `http://localhost:15672` (usuário/senha do `.env`).
