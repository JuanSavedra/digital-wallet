# Documentação técnica — Digital Wallet

Este diretório explica **como** e **por quê** o sistema foi construído, na ordem em que foi de fato implementado (ver `TODO.md` na raiz para o planejamento original). O público-alvo é um desenvolvedor júnior/pleno que já sabe programar mas nunca construiu um sistema com estas garantias (transações distribuídas, idempotência, mensageria confiável) — cada documento assume que você leu os anteriores.

Se você só quer avaliar o projeto rapidamente, leia o [`README.md`](../README.md) da raiz. Se quer entender de verdade como cada peça funciona por dentro, comece por aqui.

## Como ler

1. Comece por [`00-conceitos-gerais.md`](./00-conceitos-gerais.md) — define os conceitos (outbox, idempotência, lock otimista vs. distribuído, ledger de dupla entrada, etc.) que os documentos seguintes assumem que você já entende. Sem isso, os docs de escopo vão parecer uma lista de decisões arbitrárias.
2. Siga os documentos por escopo, na ordem numérica — cada um corresponde a uma seção do `TODO.md` e ao estado do sistema **depois** daquele escopo ser implementado.
3. Cada documento de escopo segue a mesma estrutura: **o que foi pedido**, **como foi resolvido** (com caminhos de arquivo reais), **como se conecta com o resto do sistema**, e **como validar** (comandos reais).

## Índice

| # | Documento | Tema |
|---|---|---|
| — | [00 — Conceitos gerais](./00-conceitos-gerais.md) | Vocabulário e padrões usados em todo o resto da documentação |
| 1 | [01 — Infraestrutura local](./01-infraestrutura-local.md) | Docker Compose, healthchecks, monorepo, Dockerfiles multi-stage |
| 2 | [02 — Backend, estrutura base](./02-backend-estrutura-base.md) | NestJS, config validada, filtro de exceção, logging estruturado, Swagger |
| 3 | [03 — Autenticação (JWT)](./03-autenticacao-jwt.md) | Register/login, access+refresh token, rotação, guards |
| 4 | [04 — Modelagem de dados](./04-modelagem-de-dados.md) | Schema Prisma, migrations, constraints a nível de banco |
| 5 | [05 — Idempotência nas transferências](./05-idempotencia-transferencias.md) | Header `Idempotency-Key`, máquina de estados, corrida via constraint única |
| 6 | [06 — Lock distribuído (Redis)](./06-lock-distribuido-redis.md) | `SET NX PX`, release condicional via Lua, ordenação para evitar deadlock |
| 7 | [07 — Outbox pattern](./07-outbox-pattern.md) | Consistência transação-de-negócio + evento sem 2PC |
| 8 | [08 — RabbitMQ: retry e DLQ](./08-rabbitmq-retry-dlq.md) | Topologia de filas, backoff exponencial, dead-letter queue, idempotência no consumidor |
| 9 | [09 — Cache de saldo/extrato](./09-cache-saldo-extrato-redis.md) | Cache-aside, invalidação orientada a evento |
| 10 | [10 — API: endpoints principais](./10-api-endpoints.md) | Superfície HTTP completa, autorização por endpoint |
| 11 | [11 — Frontend](./11-frontend.md) | React, TanStack Query, axios interceptors, token store |
| 12 | [12 — Depósito via AbacatePay](./12-deposito-abacatepay.md) | Gateway de pagamento real em dev mode, prevenção de depósito duplo |
| 13 | [13 — Observabilidade e qualidade](./13-observabilidade-qualidade.md) | Logs estruturados, métricas Prometheus, CI, testes de carga |
| 14 | [14 — Segurança](./14-seguranca.md) | Hardening completo: XSS/CSRF, rate limiting, ledger append-only, sanitização de logs |

## Convenções usadas nestes documentos

- Caminhos de arquivo são sempre relativos à raiz do repositório (ex.: `apps/backend/src/transactions/transactions.service.ts`).
- Trechos de código são colados do código real do projeto no momento em que este documento foi escrito — se divergirem do que você vê no repositório, o repositório está certo.
- "Escopo N" se refere sempre à seção correspondente do `TODO.md`.
