import { TRANSACTIONS_DLQ_QUEUE } from './constants';
import { DlqService } from './dlq.service';
import { RabbitMqService } from './rabbitmq.service';

describe('DlqService', () => {
  let dlqService: DlqService;
  let channel: Record<string, jest.Mock>;
  let rabbitMqService: jest.Mocked<RabbitMqService>;

  beforeEach(() => {
    channel = {
      checkQueue: jest.fn(),
      get: jest.fn(),
      publish: jest.fn(),
      ack: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const connection = { createChannel: jest.fn().mockResolvedValue(channel) };
    rabbitMqService = {
      getConnection: jest.fn().mockResolvedValue(connection),
    } as unknown as jest.Mocked<RabbitMqService>;

    dlqService = new DlqService(rabbitMqService);
  });

  it('getStatus reports the DLQ message count and closes the channel', async () => {
    channel.checkQueue.mockResolvedValue({ messageCount: 3 });

    const status = await dlqService.getStatus();

    expect(status).toEqual({ queue: TRANSACTIONS_DLQ_QUEUE, messageCount: 3 });
    expect(channel.close).toHaveBeenCalled();
  });

  it('replay republishes each message and acks it, stopping when the queue is empty', async () => {
    const msg1 = { content: Buffer.from('{}') };
    const msg2 = { content: Buffer.from('{}') };
    channel.get
      .mockResolvedValueOnce(msg1)
      .mockResolvedValueOnce(msg2)
      .mockResolvedValueOnce(false);

    const replayed = await dlqService.replay(10);

    expect(replayed).toBe(2);
    expect(channel.publish).toHaveBeenCalledTimes(2);
    expect(channel.ack).toHaveBeenCalledWith(msg1);
    expect(channel.ack).toHaveBeenCalledWith(msg2);
    expect(channel.close).toHaveBeenCalled();
  });

  it('replay respects the maxMessages cap', async () => {
    channel.get.mockResolvedValue({ content: Buffer.from('{}') });

    const replayed = await dlqService.replay(3);

    expect(replayed).toBe(3);
    expect(channel.get).toHaveBeenCalledTimes(3);
  });
});
