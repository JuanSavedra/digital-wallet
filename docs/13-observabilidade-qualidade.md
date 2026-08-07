# 13 — Observabilidade e qualidade

## O que o Escopo 13 pedia

Logs estruturados com correlation id atravessando HTTP → outbox → RabbitMQ → consumidor; métricas básicas (latência de transferência, taxa de erro, tamanho da DLQ, cache hit/miss); testes unitários, de integração e de carga/concorrência; e um pipeline de CI para os dois workspaces.

Boa parte da infraestrutura de logging já foi construída no Escopo 2 (`LoggingInterceptor`, `RequestContext`); este documento foca no que é específico de observabilidade/qualidade como disciplina — métricas e CI — e consolida onde os testes de cada camada vivem.

## Como foi resolvido

### Logs estruturados e correlation id — já existente, aplicado consistentemente

O `x-request-id` gerado em `LoggingInterceptor` (Escopo 2) e propagado via `RequestContext` (`AsyncLocalStorage`) é o backbone de rastreabilidade do sistema. O que este escopo garante é que ele realmente atravessa todas as fronteiras de processo:

- **HTTP → Outbox**: `TransactionsService.executeTransfer` grava `correlationId: RequestContext.getCorrelationId()` no `OutboxEvent` (ver [`07-outbox-pattern.md`](./07-outbox-pattern.md)).
- **Outbox → RabbitMQ**: `OutboxRelayService` inclui esse mesmo `correlationId` no payload publicado.
- **RabbitMQ → Consumidor**: `TransactionEventsConsumer.onMessage` recupera o `correlationId` do evento consumido e reabre um novo `RequestContext.run` com ele antes de processar (com fallback para um `randomUUID()` novo apenas se a mensagem não tiver um — ex.: mensagens antigas).

O resultado prático: um `grep <correlation-id>` nos logs do backend reconstrói, em ordem, a jornada completa de uma única transferência — desde a requisição HTTP original até a invalidação de cache disparada pelo consumidor — mesmo que essas etapas tenham acontecido em processos ou momentos diferentes.

### `JsonLoggerService` — todo log passa por sanitização

Este escopo estabelece que **todo** stdout/stderr do backend é JSON estruturado, não texto livre — pré-requisito tanto para observabilidade (logs são fáceis de indexar/consultar em qualquer stack de agregação) quanto para a sanitização implementada no Escopo 14 (`redact()`, aplicado a todo log antes de sair — ver [`14-seguranca.md`](./14-seguranca.md), já que os dois andam juntos na prática).

### Métricas — Prometheus via `prom-client`

`MetricsService` (`src/metrics/metrics.service.ts`) expõe quatro instrumentos:

```ts
private readonly transferDuration = new Histogram({ name: 'wallet_transfer_duration_seconds', buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5], ... });
private readonly transferErrors  = new Counter({ name: 'wallet_transfer_errors_total', labelNames: ['reason'], ... });
private readonly cacheHits       = new Counter({ name: 'wallet_cache_hits_total', labelNames: ['cache'], ... });
private readonly cacheMisses     = new Counter({ name: 'wallet_cache_misses_total', labelNames: ['cache'], ... });
private readonly dlqSize         = new Gauge({ name: 'wallet_dlq_size', ... });
```

Cada um mapeia diretamente para uma das quatro métricas pedidas no `TODO.md` (latência de transferência, taxa de erro, cache hit/miss, tamanho da DLQ). `collectDefaultMetrics({ register: this.registry })` no construtor também expõe métricas padrão de processo Node (uso de memória, event loop lag, etc.) de graça, sem código adicional.

O uso é discreto, espalhado nos pontos de origem de cada métrica, não centralizado:

- `TransactionsService.transfer` envolve toda a chamada com `startTransferTimer()`/`stopTimer()` (um `finally`, então o tempo é medido mesmo em caso de erro) e cada `catch` chama `recordTransferError(reason)` com um motivo específico (`insufficient_balance`, `lock_conflict`, `concurrent_modification`, `not_found`, `validation`, `unexpected`) — granularidade suficiente para distinguir, num dashboard, "estamos rejeitando por saldo insuficiente" de "estamos rejeitando por contenção de lock", que pedem reações operacionais bem diferentes.
- `WalletsService.getCachedBalance`/`getStatement` chamam `recordCacheHit`/`recordCacheMiss` a cada leitura (ver [`09-cache-saldo-extrato-redis.md`](./09-cache-saldo-extrato-redis.md)).
- `dlqSize` é atualizado por um poller dedicado (`DlqMetricsPoller`) que consulta `DlqService.getStatus()` periodicamente — mantendo essa métrica desacoplada do fluxo síncrono de processamento de mensagens.

`GET /api/metrics` expõe tudo isso no formato texto do Prometheus, protegido por um token opcional (`METRICS_TOKEN`) desde o Escopo 14 — ver lá o motivo.

### Pirâmide de testes real, não só unitários

O `TODO.md` distingue três camadas, e o projeto de fato as mantém separadas:

| Camada | O que cobre | Infra necessária |
|---|---|---|
| Unitário (`*.spec.ts`) | Regras de negócio isoladas via mocks — saldo insuficiente, ramos de idempotência, lock | Nenhuma |
| Integração/e2e (`test/*.e2e-spec.ts`) | Componentes reais interagindo — Postgres, Redis, RabbitMQ de verdade via `docker compose` | `make up` |
| Carga/concorrência | Transferências simultâneas na mesma carteira, via `Promise.all`/`curl` em paralelo | `make up` |

Uma decisão explícita registrada no `TODO.md`: os testes de integração usam um **docker-compose de teste** (a mesma infraestrutura real, não mocks), e não Testcontainers. A troca é sobre simplicidade de setup local versus isolamento automático por teste — Testcontainers gerenciaria containers efêmeros por suíte, mas adicionaria uma dependência e uma camada de abstração a mais; usar a mesma infraestrutura do `docker-compose.yml` de desenvolvimento manteve o ambiente de teste próximo do ambiente real, ao custo de precisar gerenciar manualmente o estado entre execuções (ver `test/setup-e2e.ts` e a nota sobre parar o backend antes de rodar e2e de mensageria, no Escopo 9).

Os testes de carga/concorrência não são uma suíte separada com ferramenta dedicada (ex.: k6, Artillery) — são testes de concorrência real embutidos nas próprias suítes e2e relevantes (`transfer.e2e-spec.ts`, `wallets.e2e-spec.ts`), disparando `Promise.all` de requisições HTTP simultâneas e verificando o resultado final. Isso prova a correção sob concorrência sem precisar de uma ferramenta de carga separada — o objetivo aqui é corretude sob concorrência real, não medir throughput máximo.

### `test/utils/ledger-cleanup.ts` — um detalhe de infraestrutura de teste que vale entender

```ts
export async function deleteLedgerEntries(prisma: PrismaLike, where: Prisma.LedgerEntryWhereInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.ledger_maintenance = 'on'`);
    await tx.ledgerEntry.deleteMany({ where });
  });
}
```

Como `transaction_entries` é append-only por trigger no banco (Escopo 4/14), a limpeza entre execuções de teste precisa da escotilha de sessão (`app.ledger_maintenance`). O detalhe técnico que vale entender: `SET LOCAL` só tem efeito dentro de uma transação, e **precisa rodar na mesma conexão física** que executa o `deleteMany` depois — por isso o código usa a transação interativa do Prisma (`$transaction(async (tx) => ...)`, que fixa uma única conexão do pool para todo o bloco), em vez de dois `$executeRaw`/`deleteMany` soltos, que poderiam (num pool de conexões) cair em conexões diferentes e esbarrar na trigger normalmente.

### CI (`.github/workflows/ci.yml`) — três jobs paralelos

```yaml
jobs:
  backend:      # lint + npm run test -- --ci + build — sem infra nenhuma
  backend-e2e:  # postgres/redis/rabbitmq como "services" do próprio job + npm run test:e2e
  frontend:     # lint + test + build
```

`backend-e2e` usa os `services:` nativos do GitHub Actions (Postgres, Redis, RabbitMQ como containers sidecar do job, com healthcheck) — o equivalente, em CI, ao `docker compose up` que um desenvolvedor rodaria localmente via `make up`. Um detalhe de configuração de CI documentado no próprio workflow: o `ABACATEPAY_API_KEY` (necessário para os testes e2e de depósito baterem na API real) foi cadastrado como secret de **Environment** ("Development", em Settings > Environments do GitHub), não como secret de repositório — por isso o job declara `environment: Development` explicitamente; sem essa linha, o job não teria acesso a secrets de Environment nenhum, e os testes de depósito falhariam silenciosamente por falta de credencial.

## Como se conecta com o resto do sistema

- Toda a infraestrutura de correlation id construída aqui é o que torna [`08-rabbitmq-retry-dlq.md`](./08-rabbitmq-retry-dlq.md) e [`07-outbox-pattern.md`](./07-outbox-pattern.md) depuráveis de ponta a ponta.
- `MetricsService` é injetado em `TransactionsService` e `WalletsService` — qualquer novo caminho de código que precise de uma métrica nova segue o mesmo padrão (instrumento declarado no construtor de `MetricsService`, chamado no ponto de origem do evento).
- A proteção de `/api/metrics` por `METRICS_TOKEN` e o `AdminGuard` de `/admin/dlq` (mencionado aqui via `DlqMetricsPoller`) são detalhados em [`14-seguranca.md`](./14-seguranca.md).

## Como validar

```bash
cd apps/backend
npm run test -- --ci
docker compose stop backend
npm run test:e2e
docker compose up -d backend
curl http://localhost:3000/api/metrics   # texto formato Prometheus
```

O estado atual da suíte completa do backend (registrado no `TODO.md` ao final do Escopo 14): 143 testes unitários em 26 suítes, 68 testes e2e em 11 suítes, todos verdes.
