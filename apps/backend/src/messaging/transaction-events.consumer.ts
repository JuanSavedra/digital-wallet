import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';
import { RedisService } from '../cache/redis.service';
import {
  MAX_RETRY_ATTEMPTS,
  PROCESSED_EVENT_DEDUP_TTL_SECONDS,
  retryBackoffMs,
  TRANSACTIONS_DLQ_QUEUE,
  TRANSACTIONS_PROCESS_QUEUE,
  TRANSACTIONS_RETRY_QUEUE,
  TRANSACTION_COMPLETED_ROUTING_KEY,
  WALLET_EVENTS_EXCHANGE,
} from './constants';
import { WalletEventMessage } from './interfaces/wallet-event.interface';
import { RabbitMqService } from './rabbitmq.service';
import { TransactionEventsHandler } from './transaction-events.handler';

const RETRY_COUNT_HEADER = 'x-retry-count';

@Injectable()
export class TransactionEventsConsumer implements OnModuleInit {
  private readonly logger = new Logger(TransactionEventsConsumer.name);
  private channel?: Channel;

  constructor(
    private readonly rabbitMqService: RabbitMqService,
    private readonly redisService: RedisService,
    private readonly handler: TransactionEventsHandler,
  ) {}

  async onModuleInit(): Promise<void> {
    const connection = await this.rabbitMqService.getConnection();
    this.channel = await connection.createChannel();

    await this.channel.assertExchange(WALLET_EVENTS_EXCHANGE, 'topic', {
      durable: true,
    });

    await this.channel.assertQueue(TRANSACTIONS_PROCESS_QUEUE, {
      durable: true,
    });
    await this.channel.bindQueue(
      TRANSACTIONS_PROCESS_QUEUE,
      WALLET_EVENTS_EXCHANGE,
      TRANSACTION_COMPLETED_ROUTING_KEY,
    );

    // Fila "parking lot": mensagens ficam aqui até o TTL (por mensagem)
    // expirar, e o dead-letter da própria fila as devolve pra exchange
    // principal — é assim que o retry com atraso acontece sem precisar de
    // um scheduler externo.
    await this.channel.assertQueue(TRANSACTIONS_RETRY_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': WALLET_EVENTS_EXCHANGE,
        'x-dead-letter-routing-key': TRANSACTION_COMPLETED_ROUTING_KEY,
      },
    });

    await this.channel.assertQueue(TRANSACTIONS_DLQ_QUEUE, { durable: true });

    await this.channel.prefetch(10);
    await this.channel.consume(
      TRANSACTIONS_PROCESS_QUEUE,
      (msg) => {
        if (msg) {
          void this.onMessage(msg);
        }
      },
      { noAck: false },
    );

    this.logger.log(
      `Consumindo ${TRANSACTIONS_PROCESS_QUEUE} (retry: ${TRANSACTIONS_RETRY_QUEUE}, dlq: ${TRANSACTIONS_DLQ_QUEUE})`,
    );
  }

  // Sem onModuleDestroy próprio de propósito: fechar este canal
  // separadamente da conexão compartilhada (RabbitMqService) tem uma
  // corrida real — se a conexão for fechada primeiro (a ordem de
  // onModuleDestroy entre providers irmãos não é garantida), fechar um
  // canal cuja conexão já caiu trava para sempre. Encerrar a conexão em
  // RabbitMqService.onModuleDestroy já fecha todos os canais nela.

  private async onMessage(msg: ConsumeMessage): Promise<void> {
    const channel = this.getChannel();
    const event = JSON.parse(msg.content.toString()) as WalletEventMessage;
    const retryCount = this.getRetryCount(msg);
    const dedupKey = `processed:event:${event.id}`;

    const claimed = await this.redisService.setIfNotExists(
      dedupKey,
      PROCESSED_EVENT_DEDUP_TTL_SECONDS,
    );
    if (!claimed) {
      this.logger.log(`Evento ${event.id} já processado, ignorando duplicata`);
      channel.ack(msg);
      return;
    }

    try {
      await this.handler.handle(event);
      channel.ack(msg);
    } catch (error) {
      // Libera a chave: se não fosse isso, a próxima tentativa (que é uma
      // mensagem nova, redirecionada da fila de retry) seria descartada
      // como "duplicata" sem nunca chegar a tentar de novo de verdade.
      await this.redisService.del(dedupKey);

      if (retryCount >= MAX_RETRY_ATTEMPTS) {
        channel.sendToQueue(TRANSACTIONS_DLQ_QUEUE, msg.content, {
          persistent: true,
          headers: {
            ...msg.properties.headers,
            [RETRY_COUNT_HEADER]: retryCount,
          },
        });
        channel.ack(msg);
        this.logger.error(
          `Evento ${event.id} excedeu ${MAX_RETRY_ATTEMPTS} tentativas, movido para a DLQ: ${(error as Error).message}`,
        );
        return;
      }

      const delayMs = retryBackoffMs(retryCount);
      channel.sendToQueue(TRANSACTIONS_RETRY_QUEUE, msg.content, {
        persistent: true,
        expiration: String(delayMs),
        headers: {
          ...msg.properties.headers,
          [RETRY_COUNT_HEADER]: retryCount + 1,
        },
      });
      channel.ack(msg);
      this.logger.warn(
        `Evento ${event.id} falhou (tentativa ${retryCount + 1}/${MAX_RETRY_ATTEMPTS + 1}), nova tentativa em ${delayMs}ms: ${(error as Error).message}`,
      );
    }
  }

  private getRetryCount(msg: ConsumeMessage): number {
    const value: unknown = msg.properties.headers?.[RETRY_COUNT_HEADER];
    return typeof value === 'number' ? value : 0;
  }

  private getChannel(): Channel {
    if (!this.channel) {
      throw new Error('Canal do consumer ainda não foi inicializado');
    }
    return this.channel;
  }
}
