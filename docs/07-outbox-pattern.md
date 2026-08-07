# 07 — Persistência transacional + Outbox pattern

## O que o Escopo 7 pedia

Garantir que débito, crédito, lançamentos no ledger e o registro do evento a publicar aconteçam na mesma transação SQL; um serviço de relay que efetivamente publica no RabbitMQ com confirmação real do broker; tolerância a falha por evento individual sem travar o lote nem derrubar o processo; e uma limpeza periódica de eventos antigos já publicados.

Se a motivação conceitual do outbox pattern não estiver clara, ver [`00-conceitos-gerais.md`](./00-conceitos-gerais.md#outbox-pattern) antes.

## Como foi resolvido

### A escrita: o evento nasce dentro da mesma transação do negócio

Em `TransactionsService.executeTransfer` (já visto em [`05-idempotencia-transferencias.md`](./05-idempotencia-transferencias.md)), o último passo dentro do `prisma.$transaction` é:

```ts
await tx.outboxEvent.create({
  data: {
    aggregateId: completed.id,
    eventType: 'transaction.completed',
    payload: {
      transactionId: completed.id,
      originWalletId,
      destinationWalletId,
      amount: amount.toString(),   // BigInt não serializa em JSON diretamente
      status: completed.status,
    },
    status: 'PENDING',
    correlationId: RequestContext.getCorrelationId(),
  },
});
```

Isso acontece **depois** do débito, do crédito e dos dois lançamentos do ledger, mas ainda dentro do mesmo `tx`. Se qualquer coisa acima falhar (saldo insuficiente, conflito de `version`), o `$transaction` inteiro sofre rollback — inclusive este insert. É fisicamente impossível existir um evento na `outbox_events` para uma transferência que não foi de fato persistida, porque as duas coisas commitam atomicamente ou nenhuma commita, garantido pelo próprio Postgres, sem nenhuma coordenação adicional entre sistemas.

O `correlationId` gravado aqui vem do `RequestContext` estabelecido pelo `LoggingInterceptor` (Escopo 2) — é assim que o `x-request-id` da requisição HTTP original atravessa até o payload do evento publicado, permitindo reconstruir a jornada completa nos logs (ver [`13-observabilidade-qualidade.md`](./13-observabilidade-qualidade.md)).

### O nível de isolamento da transação

O `TODO.md` documenta uma decisão explícita: o `$transaction` roda no isolamento padrão do Postgres (`READ COMMITTED`), sem subir para `SERIALIZABLE`/`REPEATABLE READ`. A razão é que a correção sob concorrência já vem de outras duas camadas — o lock distribuído (Escopo 6) e o lock otimista via `version` (Escopo 5) — não do nível de isolamento da transação em si. Subir o isolamento aumentaria o custo (mais abortos de transação sob contenção) sem adicionar garantia que já não exista.

### O relay: quem realmente publica

`OutboxRelayService` (`src/outbox/outbox-relay.service.ts`) roda via `@Interval(2_000)` — um polling simples, não um listener reativo (`LISTEN`/`NOTIFY` do Postgres seria uma alternativa, mas polling a cada 2s é suficientemente simples e suficientemente rápido para os requisitos deste projeto):

```ts
@Interval(OUTBOX_RELAY_INTERVAL_MS)
async relayPendingEvents(): Promise<void> {
  const pendingEvents = await this.prisma.outboxEvent.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: OUTBOX_RELAY_BATCH_SIZE,   // 20
  });

  for (const event of pendingEvents) {
    try {
      await this.rabbitMqService.publish(WALLET_EVENTS_EXCHANGE, event.eventType, { ... });
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
    } catch (error) {
      // Evento continua PENDING: a próxima execução tenta de novo.
      this.logger.error(`Falha ao publicar evento de outbox ${event.id}: ...`);
    }
  }
}
```

Dois detalhes de robustez que valem destacar:

1. **O `try/catch` está dentro do loop `for`, por evento**, não em volta do loop inteiro. Se o evento #3 de um lote de 20 falhar ao publicar, os eventos #4 a #20 ainda são tentados normalmente — uma falha isolada não bloqueia o lote inteiro. O evento problemático simplesmente permanece `PENDING` e será re-tentado no próximo tick, 2 segundos depois.
2. **`status: 'PUBLISHED'` só é gravado depois que `publish()` retorna com sucesso** — e `publish()`, por sua vez, só retorna depois de uma confirmação real do broker (ver abaixo). Isso evita a situação onde o banco "mente" dizendo que algo foi publicado quando na verdade só foi *tentado*.

### `RabbitMqService.publish` — confirm channel, não fire-and-forget

```ts
async publish(exchange: string, routingKey: string, payload: unknown): Promise<void> {
  const channel = await this.channelPromise;   // ConfirmChannel, não Channel comum
  await this.ensureExchange(exchange, channel);

  channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(payload)), {
    persistent: true,
    contentType: 'application/json',
  });
  await channel.waitForConfirms();
}
```

`channel.publish()` do `amqplib`, sozinho, só garante que a mensagem foi **enviada ao socket TCP** — não que o broker de fato a recebeu e persistiu. Um `ConfirmChannel` (`connection.createConfirmChannel()`) habilita *publisher confirms*: o broker envia um ack de volta quando a mensagem é aceita, e `waitForConfirms()` espera por esse ack antes de resolver. É essa espera explícita que torna seguro marcar o evento como `PUBLISHED` logo em seguida — sem `waitForConfirms()`, existiria uma janela onde o processo poderia cair entre "mandei pro socket" e "o broker realmente recebeu", perdendo o evento silenciosamente.

`persistent: true` garante que a mensagem sobrevive a um restart do próprio RabbitMQ (é escrita em disco, não só mantida em memória) — coerente com a exchange `wallet.events` sendo declarada `durable: true`.

### `OutboxCleanupService` — não deixar a tabela crescer para sempre

```ts
@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
async cleanupPublishedEvents(retentionDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await this.prisma.outboxEvent.deleteMany({
    where: { status: 'PUBLISHED', publishedAt: { lt: cutoff } },
  });
  return result.count;
}
```

Só apaga eventos já `PUBLISHED` e mais antigos que 7 dias — eventos `PENDING`, não importa a idade, nunca são tocados por este job (eles são responsabilidade do relay, não da limpeza). Isso mantém a tabela `outbox_events` do tamanho da carga recente, em vez de crescer indefinidamente com o histórico de uma aplicação que roda por anos.

## Como se conecta com o resto do sistema

- O evento publicado aqui (`transaction.completed` na exchange `wallet.events`) é exatamente o que `TransactionEventsConsumer` consome no Escopo 8 — ver [`08-rabbitmq-retry-dlq.md`](./08-rabbitmq-retry-dlq.md).
- `RabbitMqService.getConnection()` expõe a conexão TCP compartilhada para outros serviços (o consumer, a DLQ) abrirem seus próprios canais — a decisão de shutdown que resulta disso (só `RabbitMqService` fecha a conexão) está detalhada no Escopo 8.
- `DepositsService.confirmPaid` (Escopo 12) segue exatamente o mesmo padrão de escrever dentro de uma `$transaction`, embora hoje não publique um evento de outbox — só o débito/crédito/ledger do depósito.

## Como validar

```bash
cd apps/backend
npm run test                 # unitário: relay publica e marca, isola falha por evento; cleanup filtra por status+data
docker compose stop backend
npm run test:e2e -- outbox   # e2e contra RabbitMQ real — declara uma fila própria e CONSOME a mensagem publicada
docker compose up -d backend
```

O teste e2e não confia só no status gravado no banco — ele declara uma fila ligada à exchange `wallet.events` e consome de verdade a mensagem publicada pelo relay, confirmando que ela chegou ao broker com o conteúdo esperado. Validação manual: criar uma transferência e observar, via `docker compose logs -f backend` ou consultando `outbox_events` diretamente, o status mudar de `PENDING` para `PUBLISHED` em até ~2-3 segundos.
