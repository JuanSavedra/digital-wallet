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

  /**
   * Fechar sem deixar escapar exceção é intencional: `NestApplicationContext
   * .close()` chama `onModuleDestroy` de todos os providers num loop
   * sequencial e só segue para o hook que limpa os `@Interval`/`@Cron`
   * (`ScheduleModule`, usado por `DlqMetricsPoller`/`OutboxRelayService`)
   * depois que esse loop inteiro termina. Se a conexão já caiu sozinha
   * (rede instável, container de RabbitMQ reiniciado) e `channel.close()`
   * ou `connection.close()` lançar, o loop aborta e aqueles intervals nunca
   * são limpos — eles continuam disparando pra sempre contra uma conexão
   * morta, deixando o processo (e o `app.close()` de qualquer teste e2e)
   * pendurado.
   */
  async onModuleDestroy(): Promise<void> {
    const channel = await this.channelPromise;
    const connection = await this.connectionPromise;
    try {
      await channel.close();
    } catch (error) {
      this.logger.warn(
        `Falha ao fechar o canal do RabbitMQ (provavelmente já estava fechado): ${(error as Error).message}`,
      );
    }
    try {
      await connection.close();
    } catch (error) {
      this.logger.warn(
        `Falha ao fechar a conexão com o RabbitMQ (provavelmente já estava fechada): ${(error as Error).message}`,
      );
    }
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
