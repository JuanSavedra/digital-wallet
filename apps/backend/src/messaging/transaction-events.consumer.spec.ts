import type { ConsumeMessage } from 'amqplib';
import { RedisService } from '../cache/redis.service';
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
    channel = {
      assertExchange: jest.fn().mockResolvedValue(undefined),
      assertQueue: jest.fn().mockResolvedValue(undefined),
      bindQueue: jest.fn().mockResolvedValue(undefined),
      prefetch: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockResolvedValue(undefined),
      ack: jest.fn(),
      sendToQueue: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
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

  it('skips a duplicate event without invoking the handler', async () => {
    redisService.setIfNotExists.mockResolvedValue(false);
    const msg = makeMessage({ id: 'evt-1', aggregateId: 'tx-1' });

    await deliver(msg);

    expect(handler.handle).not.toHaveBeenCalled();
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
});
