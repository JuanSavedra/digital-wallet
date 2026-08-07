import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

export const OUTBOX_RETENTION_DAYS = 7;

@Injectable()
export class OutboxCleanupService {
  private readonly logger = new Logger(OutboxCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupPublishedEvents(
    retentionDays: number = OUTBOX_RETENTION_DAYS,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const result = await this.prisma.outboxEvent.deleteMany({
      where: { status: 'PUBLISHED', publishedAt: { lt: cutoff } },
    });

    if (result.count > 0) {
      this.logger.log(
        `Removidos ${result.count} eventos de outbox já publicados`,
      );
    }
    return result.count;
  }
}
