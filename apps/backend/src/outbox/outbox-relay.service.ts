import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { WALLET_EVENTS_EXCHANGE } from '../messaging/constants';
import { RabbitMqService } from '../messaging/rabbitmq.service';
import { PrismaService } from '../prisma/prisma.service';

export const OUTBOX_RELAY_INTERVAL_MS = 2_000;
export const OUTBOX_RELAY_BATCH_SIZE = 20;

@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbitMqService: RabbitMqService,
  ) {}

  @Interval(OUTBOX_RELAY_INTERVAL_MS)
  async relayPendingEvents(): Promise<void> {
    const pendingEvents = await this.prisma.outboxEvent.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: OUTBOX_RELAY_BATCH_SIZE,
    });

    for (const event of pendingEvents) {
      try {
        await this.rabbitMqService.publish(
          WALLET_EVENTS_EXCHANGE,
          event.eventType,
          {
            id: event.id,
            aggregateId: event.aggregateId,
            eventType: event.eventType,
            payload: event.payload,
          },
        );

        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: { status: 'PUBLISHED', publishedAt: new Date() },
        });
      } catch (error) {
        // Evento continua PENDING: a próxima execução do relay tenta de
        // novo. Um evento com problema não pode travar os demais do lote.
        this.logger.error(
          `Falha ao publicar evento de outbox ${event.id}: ${(error as Error).message}`,
        );
      }
    }
  }
}
