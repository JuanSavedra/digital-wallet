import { WALLET_EVENTS_EXCHANGE } from '../messaging/constants';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxRelayService } from './outbox-relay.service';

describe('OutboxRelayService', () => {
  let service: OutboxRelayService;
  let prisma: { outboxEvent: Record<string, jest.Mock> };
  let rabbitMqService: jest.Mocked<RabbitMqService>;

  const pendingEvent = {
    id: 'event-1',
    aggregateId: 'tx-1',
    eventType: 'transaction.completed',
    payload: { transactionId: 'tx-1' },
    status: 'PENDING',
  };

  beforeEach(() => {
    prisma = {
      outboxEvent: { findMany: jest.fn(), update: jest.fn() },
    };
    rabbitMqService = {
      publish: jest.fn(),
    } as unknown as jest.Mocked<RabbitMqService>;

    service = new OutboxRelayService(
      prisma as unknown as PrismaService,
      rabbitMqService,
    );
  });

  it('publishes each pending event and marks it PUBLISHED', async () => {
    prisma.outboxEvent.findMany.mockResolvedValue([pendingEvent]);
    rabbitMqService.publish.mockResolvedValue(undefined);

    await service.relayPendingEvents();

    expect(rabbitMqService.publish).toHaveBeenCalledWith(
      WALLET_EVENTS_EXCHANGE,
      pendingEvent.eventType,
      expect.objectContaining({ id: pendingEvent.id, aggregateId: 'tx-1' }),
    );
    expect(prisma.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: pendingEvent.id },
      data: { status: 'PUBLISHED', publishedAt: expect.any(Date) as Date },
    });
  });

  it('only fetches PENDING events, oldest first', async () => {
    prisma.outboxEvent.findMany.mockResolvedValue([]);

    await service.relayPendingEvents();

    expect(prisma.outboxEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
      }),
    );
  });

  it('leaves the event PENDING and keeps processing the rest when publish fails', async () => {
    const secondEvent = { ...pendingEvent, id: 'event-2' };
    prisma.outboxEvent.findMany.mockResolvedValue([pendingEvent, secondEvent]);
    rabbitMqService.publish
      .mockRejectedValueOnce(new Error('broker indisponível'))
      .mockResolvedValueOnce(undefined);

    await service.relayPendingEvents();

    expect(prisma.outboxEvent.update).toHaveBeenCalledTimes(1);
    expect(prisma.outboxEvent.update).toHaveBeenCalledWith({
      where: { id: secondEvent.id },
      data: { status: 'PUBLISHED', publishedAt: expect.any(Date) as Date },
    });
  });
});
