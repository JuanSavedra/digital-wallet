import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../cache/redis.service';
import { RequestContext } from '../common/context/request-context';
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
  /** Vira `true` quando o canal cai (normalmente porque a conexão
   * compartilhada foi fechada no shutdown). Ver `processMessage`. */
  private channelClosed = false;

  constructor(
    private readonly rabbitMqService: RabbitMqService,
    private readonly redisService: RedisService,
    private readonly handler: TransactionEventsHandler,
  ) {}

  async onModuleInit(): Promise<void> {
    const connection = await this.rabbitMqService.getConnection();
    this.channel = await connection.createChannel();

    // Fechar a conexão compartilhada derruba este canal junto. Registrar o
    // fato aqui é o que permite abortar cedo um processamento em voo em vez
    // de tentar publicar num canal morto (ver `processMessage`).
    this.channel.on('close', () => {
      this.channelClosed = true;
    });
    // Sem este listener, um erro de canal vira 'error' não tratado no
    // EventEmitter e derruba o processo.
    this.channel.on('error', (error: Error) => {
      this.channelClosed = true;
      this.logger.warn(`Canal do consumer com erro: ${error.message}`);
    });

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

  /**
   * Rede de proteção obrigatória: o callback do `channel.consume` invoca
   * isto com `void`, então **qualquer** rejeição que escape daqui vira uma
   * unhandled rejection — que derruba o processo em produção e faz a suíte
   * e2e inteira falhar como "Test suite failed to run", mesmo com todos os
   * testes verdes (foi exatamente o que aconteceu no CI: o app fechava a
   * conexão do RabbitMQ enquanto uma mensagem ainda estava em voo, e o
   * `sendToQueue` da fila de retry estourava `IllegalOperationError`).
   *
   * A mensagem não ackada volta para a fila e é reentregue — o contrato
   * at-least-once que a dedupe por Redis já cobre.
   */
  private async onMessage(msg: ConsumeMessage): Promise<void> {
    try {
      const event = JSON.parse(msg.content.toString()) as WalletEventMessage;
      // O evento carrega o correlationId que nasceu na requisição HTTP que
      // originou a transferência (ver TransactionsService/OutboxRelayService);
      // quando não tem (ex. mensagem antiga, mensagem sem correlationId),
      // cria um novo só para amarrar os logs deste processamento entre si.
      await RequestContext.run(
        { correlationId: event.correlationId ?? randomUUID() },
        () => this.processMessage(msg, event),
      );
    } catch (error) {
      const message = (error as Error).message;
      if (this.channelClosed) {
        this.logger.warn(
          `Processamento abortado: canal fechado durante o shutdown (${message}). A mensagem será reentregue.`,
        );
        return;
      }
      this.logger.error(
        `Falha inesperada ao processar mensagem, sem ack (será reentregue): ${message}`,
      );
    }
  }

  private async processMessage(
    msg: ConsumeMessage,
    event: WalletEventMessage,
  ): Promise<void> {
    const channel = this.getChannel();
    const retryCount = this.getRetryCount(msg);
    const dedupKey = `processed:event:${event.id}`;

    // Se o canal já caiu, não há como ackar nem republicar: qualquer coisa
    // feita a partir daqui só produz erro. Sair antes evita também gastar a
    // chave de dedupe num processamento que não vai poder ser concluído.
    if (this.channelClosed) {
      this.logger.warn(
        `Canal fechado antes de processar o evento ${event.id}; a mensagem será reentregue.`,
      );
      return;
    }

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
      // como "duplicata" sem nunca chegar a tentar de novo de verdade. Se o
      // próprio Redis estiver indisponível nesse instante (ex. desligando
      // durante o shutdown da aplicação), essa chamada não pode virar uma
      // unhandled rejection — na pior das hipóteses a chave só expira pelo
      // TTL normal e uma redelivery próxima é tratada como duplicata.
      try {
        await this.redisService.del(dedupKey);
      } catch (delError) {
        this.logger.error(
          `Falha ao liberar a chave de dedupe do evento ${event.id}, seguindo mesmo assim: ${(delError as Error).message}`,
        );
      }

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
