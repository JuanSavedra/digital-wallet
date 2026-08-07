import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelModel, ConfirmChannel, connect } from 'amqplib';

@Injectable()
export class RabbitMqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqService.name);
  private readonly assertedExchanges = new Set<string>();
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const url = this.configService.getOrThrow<string>('RABBITMQ_URL');
    this.connection = await connect(url);
    this.channel = await this.connection.createConfirmChannel();
    this.logger.log('Conectado ao RabbitMQ');
  }

  async onModuleDestroy(): Promise<void> {
    await this.channel?.close();
    await this.connection?.close();
  }

  /**
   * Publica na exchange (topic, durável) e só resolve depois que o broker
   * confirma o recebimento (publisher confirms) — sem isso, "marcar como
   * publicado" no banco seria uma mentira otimista.
   */
  async publish(
    exchange: string,
    routingKey: string,
    payload: unknown,
  ): Promise<void> {
    const channel = this.getChannel();
    await this.ensureExchange(exchange);

    channel.publish(
      exchange,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true, contentType: 'application/json' },
    );
    await channel.waitForConfirms();
  }

  private async ensureExchange(exchange: string): Promise<void> {
    if (this.assertedExchanges.has(exchange)) {
      return;
    }
    await this.getChannel().assertExchange(exchange, 'topic', {
      durable: true,
    });
    this.assertedExchanges.add(exchange);
  }

  private getChannel(): ConfirmChannel {
    if (!this.channel) {
      throw new Error('Canal do RabbitMQ ainda não foi inicializado');
    }
    return this.channel;
  }
}
