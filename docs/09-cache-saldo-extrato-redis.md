# 09 — Cache de saldo/extrato (Redis)

## O que o Escopo 9 pedia

Cache-aside para saldo (`GET /wallets/me`) e extrato paginado (`GET /wallets/me/statement`, `GET /wallets/:id/statement` — endpoints novos deste escopo), invalidação ativa disparada pelo consumidor de mensageria criado no Escopo 8, aproveitando exatamente o ponto de extensão que ali tinha sido deixado pronto.

Pré-requisito: a seção "Cache-aside" em [`00-conceitos-gerais.md`](./00-conceitos-gerais.md).

## Como foi resolvido

Tudo em `WalletsService` (`apps/backend/src/wallets/wallets.service.ts`).

### Saldo: TTL curto, chave simples

```ts
async getCachedBalance(walletId: string): Promise<bigint> {
  const cacheKey = `wallet:balance:${walletId}`;
  const cached = await this.redisService.get(cacheKey);
  if (cached !== null) {
    this.metricsService.recordCacheHit('wallet_balance');
    return BigInt(cached);
  }
  this.metricsService.recordCacheMiss('wallet_balance');

  const wallet = await this.prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
  await this.redisService.set(cacheKey, wallet.balance.toString(), 30);   // TTL de segurança
  return wallet.balance;
}
```

O padrão cache-aside clássico: tenta o Redis primeiro, em caso de *miss* busca no Postgres e povoa o cache antes de retornar. O TTL de 30s é curto de propósito — mesmo que a invalidação ativa (abaixo) falhe por algum motivo, o pior caso é o usuário ver um saldo com até 30 segundos de atraso, nunca mais que isso. `BigInt(cached)` reconstrói o tipo correto a partir da string armazenada — lembre que `wallet.balance` é `BigInt` (ver [`04-modelagem-de-dados.md`](./04-modelagem-de-dados.md)), e o Redis só guarda strings.

Cada leitura registra hit/miss via `MetricsService` — esses contadores alimentam a métrica de "cache hit/miss" exposta em `/api/metrics` (ver [`13-observabilidade-qualidade.md`](./13-observabilidade-qualidade.md)).

### Extrato: só a página 1 precisa de invalidação ativa

```ts
async getStatement(walletId: string, page: number): Promise<StatementEntry[]> {
  const cacheKey = `wallet:statement:${walletId}:page:${page}`;
  const cached = await this.redisService.get(cacheKey);
  if (cached !== null) return JSON.parse(cached) as StatementEntry[];

  const entries = await this.prisma.ledgerEntry.findMany({
    where: { walletId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * STATEMENT_PAGE_SIZE,
    take: STATEMENT_PAGE_SIZE,
  });
  ...
  await this.redisService.set(cacheKey, JSON.stringify(statement), 60);
  return statement;
}
```

O raciocínio por trás de cachear cada página separadamente (`wallet:statement:{id}:page:{n}`), com TTL de 60s: o ledger é **imutável** por natureza (ver [`04-modelagem-de-dados.md`](./04-modelagem-de-dados.md), append-only forçado por trigger) — uma vez que uma página 2, 3, 4... foi escrita, ela **nunca muda**, porque os lançamentos que a compõem nunca são alterados nem removidos, e novos lançamentos sempre aparecem no topo (mais recentes primeiro), nunca inseridos "no meio" de uma página antiga. Só a página 1 (a mais recente) muda quando uma nova transferência acontece — por isso é a única que precisa de invalidação ativa; páginas mais antigas dependem só do TTL de segurança, e mesmo esse TTL é uma formalidade, já que o conteúdo delas nunca deveria mudar de verdade.

`orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]` merece atenção: o desempate por `id` existe porque débito e crédito de uma mesma transferência nascem exatamente no mesmo instante (`createdAt` idêntico) — sem um segundo critério de ordenação, a ordem relativa entre os dois lançamentos dentro de uma página, ou entre a última linha de uma página e a primeira da próxima, não seria garantida de forma estável entre requisições diferentes.

### A ponte com o Escopo 8: invalidação disparada pelo consumidor

`TransactionEventsHandler.handle()` — o método que no Escopo 8 só logava o evento — ganha aqui sua primeira ação de negócio real:

```ts
async handle(event: WalletEventMessage): Promise<void> {
  if (event.eventType !== 'transaction.completed') return;

  const payload = event.payload as TransactionCompletedPayload;
  await Promise.all([
    this.walletsService.invalidateWalletCaches(payload.originWalletId),
    this.walletsService.invalidateWalletCaches(payload.destinationWalletId),
  ]);
}
```

```ts
async invalidateWalletCaches(walletId: string): Promise<void> {
  await Promise.all([
    this.redisService.del(`wallet:balance:${walletId}`),
    this.redisService.del(`wallet:statement:${walletId}:page:1`),
  ]);
}
```

O ponto arquitetural importante aqui: **nada na cadeia de retry/DLQ/dedupe do `TransactionEventsConsumer` precisou mudar** para isso funcionar. O consumer sempre chamou `this.handler.handle(event)` dentro do seu `try/catch` de retry — a ação de negócio dentro do handler era só um `log()` até este escopo, e passou a ser invalidação de cache, mas a interface (`handle(event): Promise<void>`, lança em caso de falha) não mudou. Isso significa que, se a invalidação de cache falhar (ex.: Redis temporariamente indisponível), o evento entra automaticamente no mesmo fluxo de retry com backoff que qualquer outra falha do handler — sem precisar de nenhum código de retry específico para cache.

### Por que cache-aside, e não write-through

A alternativa seria a própria transferência (`TransactionsService.executeTransfer`) escrever no cache diretamente, no mesmo momento em que escreve no Postgres. O projeto optou deliberadamente por não fazer isso: a escrita da transferência já lida com bastante coisa (lock distribuído, lock otimista, outbox) — acoplar mais uma responsabilidade (manter o cache consistente) a esse caminho crítico aumentaria a superfície de falha exatamente onde a correção mais importa. Cache-aside com invalidação assíncrona mantém a escrita simples, e aceita uma janela de poucos segundos onde o cache pode estar desatualizado — coberta pelo TTL de segurança enquanto a invalidação real (que roda em paralelo, via mensageria) não chega.

## Achado operacional importante: dois consumidores na mesma fila

> O container Docker do backend, que fica sempre rodando (`restart: unless-stopped`, ver [`01-infraestrutura-local.md`](./01-infraestrutura-local.md)), tem seu próprio `TransactionEventsConsumer` conectado à mesma fila `transactions.process`. Rodar os testes e2e de mensageria com esse container ativo faz os dois consumidores competirem pelas mensagens (o RabbitMQ faz round-robin entre consumidores de uma mesma fila), corrompendo os testes de forma não-determinística — às vezes a mensagem que o teste espera consumir é entregue ao *outro* processo.

A regra prática, válida para qualquer suíte e2e que envolva RabbitMQ (não só as deste escopo):

```bash
docker compose stop backend
npm run test:e2e
docker compose up -d backend
```

Este é um dos poucos casos deste projeto onde a causa raiz de uma falha de teste não estava no código, mas na topologia de execução dos testes em si — vale ter isso em mente antes de gastar tempo depurando um teste de mensageria "instável".

## Como se conecta com o resto do sistema

- Consome diretamente o trabalho do Escopo 8 (`TransactionEventsHandler`) e do Escopo 4 (o schema do ledger, fonte da verdade do extrato).
- `GET /wallets/me` e `GET /wallets/me/statement` (Escopo 10) são os endpoints que expõem `getCachedBalance`/`getStatement` publicamente.
- No Escopo 14, `getStatement` deixou de mesclar duas fontes em memória (ledger + depósitos pagos) — ver a nota no próprio código acima — depois que os depósitos passaram a gerar lançamento no ledger; hoje lê só do razão, com `skip`/`take` do Postgres em vez de paginação em memória.

## Como validar

```bash
cd apps/backend
npm run test                       # hit não bate no banco, miss povoa cache, invalidação apaga as duas chaves
docker compose stop backend
npm run test:e2e -- wallet-cache
docker compose up -d backend
```

O teste e2e prova, contra Redis e RabbitMQ reais, que o saldo/extrato exibidos refletem uma transferência recém-concluída bem antes do TTL de 30s expirar — sem a invalidação ativa, esse mesmo teste pegaria o valor cacheado antigo (é literalmente o teste que teria falhado se a invalidação não existisse).
