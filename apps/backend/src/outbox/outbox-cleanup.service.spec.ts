import { PrismaService } from '../prisma/prisma.service';
import { OutboxCleanupService } from './outbox-cleanup.service';

describe('OutboxCleanupService', () => {
  let service: OutboxCleanupService;
  let prisma: { outboxEvent: Record<string, jest.Mock> };

  beforeEach(() => {
    prisma = { outboxEvent: { deleteMany: jest.fn() } };
    service = new OutboxCleanupService(prisma as unknown as PrismaService);
  });

  it('deletes only PUBLISHED events older than the retention window', async () => {
    prisma.outboxEvent.deleteMany.mockResolvedValue({ count: 3 });

    const deleted = await service.cleanupPublishedEvents(7);

    expect(deleted).toBe(3);
    const [call] = prisma.outboxEvent.deleteMany.mock.calls[0] as [
      { where: { status: string; publishedAt: { lt: Date } } },
    ];
    expect(call.where.status).toBe('PUBLISHED');
    const expectedCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(call.where.publishedAt.lt.getTime()).toBeCloseTo(expectedCutoff, -3);
  });

  it('returns 0 when there is nothing to clean up', async () => {
    prisma.outboxEvent.deleteMany.mockResolvedValue({ count: 0 });

    const deleted = await service.cleanupPublishedEvents();

    expect(deleted).toBe(0);
  });
});
