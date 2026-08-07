import { Injectable, Logger } from '@nestjs/common';
import type { Channel } from 'amqplib';
import {
  TRANSACTIONS_DLQ_QUEUE,
  TRANSACTION_COMPLETED_ROUTING_KEY,
  WALLET_EVENTS_EXCHANGE,
} from './constants';
import { RabbitMqService } from './rabbitmq.service';

export interface DlqStatus {
  queue: string;
  messageCount: number;
}

@Injectable()
export class DlqService {
  private readonly logger = new Logger(DlqService.name);

  constructor(private readonly rabbitMqService: RabbitMqService) {}

  async getStatus(): Promise<DlqStatus> {
    const channel = await this.getChannel();
    try {
      const { messageCount } = await channel.checkQueue(TRANSACTIONS_DLQ_QUEUE);
      return { queue: TRANSACTIONS_DLQ_QUEUE, messageCount };
    } finally {
      await channel.close();
    }
  }

  /**
   * Reprocessamento manual: drena até `maxMessages` da DLQ e as republica
   * na exchange principal (retry-count zerado, como se fossem novas). Só
   * remove da DLQ (ack) depois de confirmar a republicação.
   */
  async replay(maxMessages = 50): Promise<number> {
    const channel = await this.getChannel();
    try {
      let replayed = 0;

      for (let i = 0; i < maxMessages; i++) {
        const msg = await channel.get(TRANSACTIONS_DLQ_QUEUE, {
          noAck: false,
        });
        if (!msg) {
          break;
        }

        channel.publish(
          WALLET_EVENTS_EXCHANGE,
          TRANSACTION_COMPLETED_ROUTING_KEY,
          msg.content,
          { persistent: true },
        );
        channel.ack(msg);
        replayed++;
      }

      if (replayed > 0) {
        this.logger.log(`Reprocessadas ${replayed} mensagens da DLQ`);
      }
      return replayed;
    } finally {
      await channel.close();
    }
  }

  private async getChannel(): Promise<Channel> {
    const connection = await this.rabbitMqService.getConnection();
    return connection.createChannel();
  }
}
