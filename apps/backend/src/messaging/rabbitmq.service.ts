import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelModel, ConfirmChannel, connect } from 'amqplib';

@Injectable()
export class RabbitMqService implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqService.name);
  private readonly assertedExchanges = new Set<string>();
  private readonly connectionPromise: Promise<ChannelModel>;
  private readonly channelPromise: Promise<ConfirmChannel>;

  constructor(private readonly configService: ConfigService) {
    // Conecta assim que o serviço é instanciado (não espera onModuleInit):
    // outros serviços (consumer, DLQ) dependem desta conexão via
    // getConnection(), e a ordem de execução de onModuleInit entre
    // providers irmãos não é algo em que vale a pena confiar.
    this.connectionPromise = connect(
      this.configService.getOrThrow<string>('RABBITMQ_URL'),
    ).then((connection) => {
      this.logger.log('Conectado ao RabbitMQ');
      return connection;
    });
    this.channelPromise = this.connectionPromise.then((connection) =>
      connection.createConfirmChannel(),
    );
  }

  async onModuleDestroy(): Promise<void> {
    const channel = await this.channelPromise;
    const connection = await this.connectionPromise;
    await channel.close();
    await connection.close();
  }

  /** Permite que outros serviços (consumer, DLQ) abram seus próprios
   * canais na mesma conexão TCP, em vez de abrir uma conexão por serviço. */
  getConnection(): Promise<ChannelModel> {
    return this.connectionPromise;
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
    const channel = await this.channelPromise;
    await this.ensureExchange(exchange, channel);

    channel.publish(
      exchange,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true, contentType: 'application/json' },
    );
    await channel.waitForConfirms();
  }

  private async ensureExchange(
    exchange: string,
    channel: ConfirmChannel,
  ): Promise<void> {
    if (this.assertedExchanges.has(exchange)) {
      return;
    }
    await channel.assertExchange(exchange, 'topic', { durable: true });
    this.assertedExchanges.add(exchange);
  }
}
