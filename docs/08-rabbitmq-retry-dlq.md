# 08 — RabbitMQ: processamento assíncrono, retry e DLQ

## O que o Escopo 8 pedia

A topologia de filas (fila principal, fila de retry como "parking lot", DLQ), um consumidor manual via `amqplib` (não `@nestjs/microservices`), retry com backoff exponencial rastreado em header próprio, movimentação para DLQ após esgotar tentativas, idempotência do consumidor via Redis, ack manual em todos os caminhos, e endpoints administrativos de monitoramento/replay da DLQ.

Pré-requisito de leitura: a seção "At-least-once delivery, retry e idempotência do lado do consumidor" em [`00-conceitos-gerais.md`](./00-conceitos-gerais.md).

## Como foi resolvido

### Topologia (`src/messaging/constants.ts`)

```
wallet.events (exchange, topic, durable)
      │  routing key: transaction.completed
      ▼
transactions.process  ──falha──▶  transactions.process.retry  ──TTL expira──▶  (dead-letter de volta pra wallet.events)
      │
      └─esgotou tentativas──▶  transactions.process.dlq
```

A fila `transactions.process.retry` é o mecanismo de atraso: ela **não tem consumidor nenhum**. Sua única função é segurar a mensagem pelo tempo do TTL (definido por mensagem, via `expiration`) e, quando esse TTL expira, o RabbitMQ automaticamente aplica o `x-dead-letter-exchange`/`x-dead-letter-routing-key` configurados nela, devolvendo a mensagem para `wallet.events` — que a roteia de volta para `transactions.process`, como se fosse uma mensagem nova. Isso implementa um atraso de retry **sem precisar de um scheduler externo** — o próprio TTL do RabbitMQ faz esse trabalho.

```ts
export const MAX_RETRY_ATTEMPTS = 3;   // 3 retries = até 4 tentativas no total
export function retryBackoffMs(retryCount: number): number {
  return Math.min(500 * 2 ** retryCount, 5_000);   // 500ms → 1s → 2s, teto 5s
}
```

### Por que `amqplib` manual em vez de `@nestjs/microservices`

O transporte RMQ do NestJS abstrai bastante (declaração de fila, ack/nack) mas também limita o controle fino que este projeto precisa: escrever headers customizados de retry-count, decidir manualmente entre retry/DLQ/ack, e — mais importante — **compartilhar a mesma conexão TCP** entre o publisher (`RabbitMqService`, usado pelo relay da outbox) e o consumer. Usar `amqplib` diretamente dá esse controle; o preço é reimplementar manualmente o que o transporte pronto faria de graça (bind de fila, prefetch, etc.) — uma troca deliberada, documentada no `TODO.md`.

### Contagem de tentativas: header próprio, não `x-death` automático

O RabbitMQ mantém automaticamente um header `x-death` que registra o histórico de dead-lettering de uma mensagem — mas esse formato é pensado para depuração, não para lógica de aplicação (é uma lista que cresce, com uma estrutura pensada para inspeção humana). Este projeto usa em vez disso um header próprio, `x-retry-count`, que o código escreve e lê explicitamente:

```ts
private getRetryCount(msg: ConsumeMessage): number {
  const value: unknown = msg.properties.headers?.[RETRY_COUNT_HEADER];
  return typeof value === 'number' ? value : 0;
}
```

Isso dá controle total e previsível sobre a contagem, sem depender de como o RabbitMQ formata internamente seu próprio header de auditoria (que poderia, em tese, mudar de formato entre versões do broker).

### `processMessage` — o coração da lógica de retry/DLQ/dedupe

```ts
const claimed = await this.redisService.setIfNotExists(dedupKey, PROCESSED_EVENT_DEDUP_TTL_SECONDS);
if (!claimed) {
  this.logger.log(`Evento ${event.id} já processado, ignorando duplicata`);
  channel.ack(msg);
  return;
}

try {
  await this.handler.handle(event);
  channel.ack(msg);
} catch (error) {
  await this.redisService.del(dedupKey);   // libera, para uma retentativa legítima não virar "duplicata"

  if (retryCount >= MAX_RETRY_ATTEMPTS) {
    channel.sendToQueue(TRANSACTIONS_DLQ_QUEUE, msg.content, { persistent: true, headers: { ...headers, [RETRY_COUNT_HEADER]: retryCount } });
    channel.ack(msg);
    return;
  }

  const delayMs = retryBackoffMs(retryCount);
  channel.sendToQueue(TRANSACTIONS_RETRY_QUEUE, msg.content, {
    persistent: true,
    expiration: String(delayMs),
    headers: { ...headers, [RETRY_COUNT_HEADER]: retryCount + 1 },
  });
  channel.ack(msg);
}
```

Passo a passo do raciocínio:

1. **Dedupe primeiro, antes de qualquer processamento**: `setIfNotExists` (um `SET NX` no Redis) reivindica a chave `processed:event:<id>`. Se já existir, é uma reentrega de uma mensagem já processada com sucesso anteriormente — a mensagem é confirmada (`ack`) sem rodar `handler.handle()` de novo.
2. **Se o handler falha**, a chave de dedupe é **liberada** (`del`) antes de decidir o destino da mensagem. Isso é essencial: sem liberar, a próxima tentativa (que chega como uma mensagem "nova", vinda da fila de retry) seria descartada pelo passo 1 como se já tivesse sido processada — nunca teria a chance de rodar de verdade. A liberação de chave em si é protegida por um `try/catch` interno silencioso: se o Redis estiver indisponível justamente nesse instante, o pior caso é a chave expirar sozinha pelo TTL (1h) mais tarde, sem derrubar o processo.
3. **Esgotou as tentativas → DLQ.** Note que tanto o envio para a DLQ quanto o envio para a fila de retry são seguidos de `channel.ack(msg)` na mensagem **original** — ela é removida da fila principal de qualquer forma, porque uma cópia dela já foi publicada no destino certo (retry ou DLQ). Isso é ack manual em ação: nenhum caminho (sucesso, duplicata, retry, DLQ) deixa a mensagem original pendurada na fila.

### O detalhe que derrubou o CI: unhandled rejection no shutdown

Documentado tanto no `TODO.md` quanto no próprio código, este é provavelmente o bug mais sutil de todo o projeto. O callback passado a `channel.consume` é síncrono por assinatura, mas `onMessage` é `async` — o código chama `void this.onMessage(msg)`, descartando a Promise de propósito (porque o callback do `consume` não pode ser `await`ado). O problema: **se essa Promise rejeitar, e ninguém estiver ouvindo, o Node.js trata isso como uma unhandled rejection** — que derruba o processo inteiro em produção, e no CI fazia o Jest reportar `Test suite failed to run` em `transfer.e2e-spec.ts`, **mesmo com os 68 testes daquele arquivo passando** (o processo caía durante o teardown, depois de todos os `it()` já terem rodado).

A causa raiz: quando `app.close()` fecha a conexão compartilhada do RabbitMQ enquanto uma mensagem ainda está em processamento, uma chamada subsequente como `channel.sendToQueue()` (tentando mover para retry) lança `IllegalOperationError: Channel closed` — e essa exceção escapava sem tratamento.

A correção tem duas partes que trabalham juntas:

```ts
this.channel.on('close', () => { this.channelClosed = true; });
this.channel.on('error', (error) => { this.channelClosed = true; ...; });
```

e, em `onMessage`, um `try/catch` que é **rede de proteção obrigatória** (não opcional) em volta de todo o processamento:

```ts
private async onMessage(msg: ConsumeMessage): Promise<void> {
  try {
    const event = JSON.parse(msg.content.toString());
    await RequestContext.run({ correlationId: ... }, () => this.processMessage(msg, event));
  } catch (error) {
    if (this.channelClosed) {
      this.logger.warn(`Processamento abortado: canal fechado durante o shutdown. A mensagem será reentregue.`);
      return;
    }
    this.logger.error(`Falha inesperada ao processar mensagem, sem ack: ${message}`);
  }
}
```

E dentro de `processMessage`, uma verificação **antecipada** de `channelClosed` evita até gastar a chave de dedupe num processamento que já sabemos que não vai poder terminar (nem ackar, nem republicar):

```ts
if (this.channelClosed) {
  this.logger.warn(`Canal fechado antes de processar o evento ${event.id}; a mensagem será reentregue.`);
  return;
}
```

Em nenhum desses casos a mensagem é ackada — ela simplesmente fica pendente e é reentregue pelo RabbitMQ quando a conexão for restabelecida (ou por outro consumidor, se houver). Isso é exatamente o contrato at-least-once que a dedupe via Redis já foi desenhada para cobrir — o sistema não perde robustez nenhuma ao deixar essas mensagens para reentrega, só evita que o processo inteiro morra por causa disso.

### Por que o consumer não tem `onModuleDestroy` próprio

```
// Sem onModuleDestroy próprio de propósito: fechar este canal separadamente
// da conexão compartilhada tem uma corrida real — se a conexão for fechada
// primeiro (a ordem de onModuleDestroy entre providers irmãos não é
// garantida pelo Nest), fechar um canal cuja conexão já caiu trava para
// sempre. RabbitMqService.onModuleDestroy já fecha todos os canais nela.
```

Esta é uma regra que qualquer novo serviço que abra seu próprio canal via `rabbitMqService.getConnection()` precisa respeitar: **não adicione um `onModuleDestroy` que feche esse canal independentemente**. Só `RabbitMqService` fecha a conexão TCP compartilhada — e fechar a conexão já fecha todos os canais abertos nela.

### Monitoramento e replay manual (`DlqService`, `messaging/admin.controller.ts`)

`GET /admin/dlq` consulta o tamanho da DLQ via `channel.checkQueue()` (um comando AMQP passivo, não consome nada). `POST /admin/dlq/replay` drena até N mensagens da DLQ, republica cada uma na exchange principal **com o retry-count implicitamente zerado** (não copia o header antigo, então a mensagem republicada é tratada como nova) e só dá `ack` na DLQ depois de confirmar a republicação — se o processo cair no meio do replay, mensagens ainda não republicadas continuam seguras na DLQ.

Como o `TODO.md` registra: originalmente esses dois endpoints estavam protegidos só por autenticação comum — qualquer usuário logado podia inspecionar e reprocessar eventos de transação de terceiros. Isso foi corrigido no Escopo 14 com `AdminGuard` — ver [`14-seguranca.md`](./14-seguranca.md).

## Como se conecta com o resto do sistema

- `TransactionEventsHandler.handle()` é o ponto de extensão citado pelo `TODO.md`: neste escopo ele só loga o evento recebido; o Escopo 9 estende essa mesma função para invalidar o cache de saldo/extrato, **sem tocar em nada da cadeia de retry/dedupe/DLQ acima** — ver [`09-cache-saldo-extrato-redis.md`](./09-cache-saldo-extrato-redis.md).
- O evento consumido aqui é publicado pelo `OutboxRelayService` do Escopo 7.
- A dedupe usa a mesma infraestrutura `RedisService` do lock distribuído (Escopo 6) e da allowlist de auth (Escopo 3).

## Como validar

```bash
cd apps/backend
npm run test                    # 10 unitários: novo evento, duplicata, retry com contagem incrementada, DLQ, status/replay
docker compose stop backend     # ver Escopo 9 para o porquê
npm run test:e2e -- messaging
docker compose up -d backend
```

Os testes e2e forçam falhas de verdade no handler (via override de provider do Nest) para observar retry até sucesso, DLQ após esgotar tentativas, reprocessamento manual via `/admin/dlq/replay`, e uma redelivery manual simulando at-least-once para provar que a idempotência funciona de fato — não só na teoria.
