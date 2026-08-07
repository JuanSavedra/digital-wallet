import type { ConsumeMessage } from 'amqplib';
import { RedisService } from '../cache/redis.service';
import { RequestContext } from '../common/context/request-context';
import {
  MAX_RETRY_ATTEMPTS,
  TRANSACTIONS_DLQ_QUEUE,
  TRANSACTIONS_RETRY_QUEUE,
} from './constants';
import { RabbitMqService } from './rabbitmq.service';
import { TransactionEventsConsumer } from './transaction-events.consumer';
import { TransactionEventsHandler } from './transaction-events.handler';

describe('TransactionEventsConsumer', () => {
  let consumer: TransactionEventsConsumer;
  let channel: Record<string, jest.Mock>;
  let rabbitMqService: jest.Mocked<RabbitMqService>;
  let redisService: jest.Mocked<RedisService>;
  let handler: jest.Mocked<TransactionEventsHandler>;
  let channelListeners: Record<string, (...args: unknown[]) => void>;

  // O consumer dispara `void this.onMessage(msg)` a partir do callback do
  // `channel.consume` de propósito (é assim que uma callback de consumo do
  // amqplib deve se comportar). Isso torna impossível "esperar" a
  // conclusão via esse callback num teste; chamamos o método privado
  // diretamente para poder dar `await` na promise real.
  function deliver(msg: ConsumeMessage): Promise<void> {
    return (
      consumer as unknown as {
        onMessage: (msg: ConsumeMessage) => Promise<void>;
      }
    ).onMessage(msg);
  }

  function makeMessage(
    event: Record<string, unknown>,
    headers: Record<string, unknown> = {},
  ): ConsumeMessage {
    return {
      content: Buffer.from(JSON.stringify(event)),
      properties: { headers },
    } as unknown as ConsumeMessage;
  }

  beforeEach(async () => {
    channelListeners = {};
    channel = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      assertQueue: jest.fn().mockResolvedValue(undefined),
      bindQueue: jest.fn().mockResolvedValue(undefined),
      prefetch: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockResolvedValue(undefined),
      ack: jest.fn(),
      sendToQueue: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
      // O consumer registra listeners de 'close'/'error' no canal para
      // saber que ele caiu; guardamos os handlers para poder disparar.
      on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
        channelListeners[event] = listener;
      }),
    };
    const connection = {
      createChannel: jest.fn().mockResolvedValue(channel),
    };
    rabbitMqService = {
      getConnection: jest.fn().mockResolvedValue(connection),
    } as unknown as jest.Mocked<RabbitMqService>;
    redisService = {
      setIfNotExists: jest.fn(),
      del: jest.fn(),
    } as unknown as jest.Mocked<RedisService>;
    handler = {
      handle: jest.fn(),
    } as unknown as jest.Mocked<TransactionEventsHandler>;

    consumer = new TransactionEventsConsumer(
      rabbitMqService,
      redisService,
      handler,
    );
    await consumer.onModuleInit();
  });

  it('processes a new event and acks it', async () => {
    redisService.setIfNotExists.mockResolvedValue(true);
    handler.handle.mockResolvedValue(undefined);
    const msg = makeMessage({ id: 'evt-1', aggregateId: 'tx-1' });

    await deliver(msg);

    expect(redisService.setIfNotExists).toHaveBeenCalledWith(
      'processed:event:evt-1',
      expect.any(Number),
    );
    expect(handler.handle).toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('makes the event correlationId available via RequestContext while handling', async () => {
    redisService.setIfNotExists.mockResolvedValue(true);
    let seenDuringHandle: string | undefined;
    handler.handle.mockImplementation(() => {
      seenDuringHandle = RequestContext.getCorrelationId();
      return Promise.resolve();
    });
    const msg = makeMessage({
      id: 'evt-1',
      aggregateId: 'tx-1',
      correlationId: 'req-from-http',
    });

    await deliver(msg);

    expect(seenDuringHandle).toBe('req-from-http');
  });

  it('generates a correlationId when the event does not carry one', async () => {
    redisService.setIfNotExists.mockResolvedValue(true);
    let seenDuringHandle: string | undefined;
    handler.handle.mockImplementation(() => {
      seenDuringHandle = RequestContext.getCorrelationId();
      return Promise.resolve();
    });
    const msg = makeMessage({ id: 'evt-1', aggregateId: 'tx-1' });

    await deliver(msg);

    expect(seenDuringHandle).toEqual(expect.any(String));
  });

  it('skips a duplicate event without invoking the handler', async () => {
    redisService.setIfNotExists.mockResolvedValue(false);
    const msg = makeMessage({ id: 'evt-1', aggregateId: 'tx-1' });

    await deliver(msg);

    expect(handler.handle).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it('still requeues the message even when releasing the dedupe key fails (e.g. Redis shutting down)', async () => {
    redisService.setIfNotExists.mockResolvedValue(true);
    handler.handle.mockRejectedValue(new Error('falha temporária'));
    redisService.del.mockRejectedValue(new Error('Connection is closed.'));
    const msg = makeMessage(
      { id: 'evt-1', aggregateId: 'tx-1' },
      { 'x-retry-count': 1 },
    );

    await expect(deliver(msg)).resolves.toBeUndefined();

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      TRANSACTIONS_RETRY_QUEUE,
      msg.content,
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-retry-count': 2 }),
      }),
    );
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it('requeues to the retry queue with an incremented count when below the limit', async () => {
    redisService.setIfNotExists.mockResolvedValue(true);
    handler.handle.mockRejectedValue(new Error('falha temporária'));
    const msg = makeMessage(
      { id: 'evt-1', aggregateId: 'tx-1' },
      { 'x-retry-count': 1 },
    );

    await deliver(msg);

    expect(redisService.del).toHaveBeenCalledWith('processed:event:evt-1');
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      TRANSACTIONS_RETRY_QUEUE,
      msg.content,
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-retry-count': 2 }),
        expiration: expect.any(String),
      }),
    );
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it('moves the event to the DLQ once retries are exhausted', async () => {
    redisService.setIfNotExists.mockResolvedValue(true);
    handler.handle.mockRejectedValue(new Error('falha definitiva'));
    const msg = makeMessage(
      { id: 'evt-1', aggregateId: 'tx-1' },
      { 'x-retry-count': MAX_RETRY_ATTEMPTS },
    );

    await deliver(msg);

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      TRANSACTIONS_DLQ_QUEUE,
      msg.content,
      expect.any(Object),
    );
    expect(channel.ack).toHaveBeenCalledWith(msg);
  });

  it('treats a message with no retry-count header as the first attempt', async () => {
    redisService.setIfNotExists.mockResolvedValue(true);
    handler.handle.mockRejectedValue(new Error('falha'));
    const msg = makeMessage({ id: 'evt-1', aggregateId: 'tx-1' });

    await deliver(msg);

    expect(channel.sendToQueue).toHaveBeenCalledWith(
      TRANSACTIONS_RETRY_QUEUE,
      msg.content,
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-retry-count': 1 }),
      }),
    );
  });

  describe('shutdown: canal do RabbitMQ fechado', () => {
    // Regressão do CI: com o canal já fechado, o `sendToQueue` da fila de
    // retry lançava `IllegalOperationError` de dentro de um `void
    // this.onMessage(...)`. Isso vira unhandled rejection — derruba o
    // processo em produção e faz o Jest reportar "Test suite failed to run"
    // mesmo com todos os testes verdes.

    it('não lança quando o canal cai antes de processar; a mensagem fica sem ack', async () => {
      channelListeners.close();
      const msg = makeMessage({ id: 'evt-1', aggregateId: 'tx-1' });

      await expect(deliver(msg)).resolves.toBeUndefined();

      // Sem ack e sem republicação: o RabbitMQ reentrega, que é o contrato
      // at-least-once que a dedupe por Redis já cobre.
      expect(channel.ack).not.toHaveBeenCalled();
      expect(channel.sendToQueue).not.toHaveBeenCalled();
      expect(handler.handle).not.toHaveBeenCalled();
      // A chave de dedupe nem chega a ser reivindicada.
      expect(redisService.setIfNotExists).not.toHaveBeenCalled();
    });

    it('engole o IllegalOperationError quando o canal cai no meio do processamento', async () => {
      redisService.setIfNotExists.mockResolvedValue(true);
      redisService.del.mockResolvedValue(undefined);
      handler.handle.mockRejectedValue(new Error('falha'));
      // O canal cai entre o handler falhar e a republicação na fila de retry.
      channel.sendToQueue.mockImplementation(() => {
        channelListeners.close();
        throw new Error('Channel closed');
      });
      const msg = makeMessage({ id: 'evt-1', aggregateId: 'tx-1' });

      await expect(deliver(msg)).resolves.toBeUndefined();

      expect(channel.ack).not.toHaveBeenCalled();
    });

    it('não deixa escapar erro inesperado com o canal aberto', async () => {
      redisService.setIfNotExists.mockRejectedValue(new Error('redis fora'));
      const msg = makeMessage({ id: 'evt-1', aggregateId: 'tx-1' });

      await expect(deliver(msg)).resolves.toBeUndefined();

      expect(channel.ack).not.toHaveBeenCalled();
    });

    it('marca o canal como fechado também no evento de erro', async () => {
      channelListeners.error(new Error('canal quebrou'));
      const msg = makeMessage({ id: 'evt-1', aggregateId: 'tx-1' });

      await expect(deliver(msg)).resolves.toBeUndefined();

      expect(handler.handle).not.toHaveBeenCalled();
    });
  });
});
