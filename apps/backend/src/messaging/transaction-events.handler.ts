import { Injectable, Logger } from '@nestjs/common';
import { WalletEventMessage } from './interfaces/wallet-event.interface';

/**
 * Ação de negócio disparada para cada evento `transaction.completed`
 * consumido. Por enquanto só loga — vira o ponto de extensão real no
 * Escopo 9 (invalidar/atualizar cache de saldo e extrato). Mantido como
 * classe própria (em vez de lógica solta dentro do consumer) justamente
 * para o Escopo 9 estender/substituir sem mexer na cadeia de
 * retry/DLQ/idempotência do consumer.
 */
@Injectable()
export class TransactionEventsHandler {
  private readonly logger = new Logger(TransactionEventsHandler.name);

  async handle(event: WalletEventMessage): Promise<void> {
    await Promise.resolve();
    this.logger.log(
      `Evento processado: ${event.eventType} (aggregateId=${event.aggregateId})`,
    );
  }
}
