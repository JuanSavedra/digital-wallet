import { Injectable, Logger } from '@nestjs/common';
import { WalletsService } from '../wallets/wallets.service';
import {
  TransactionCompletedPayload,
  WalletEventMessage,
} from './interfaces/wallet-event.interface';

/**
 * Ação de negócio disparada para cada evento consumido. Mantida como
 * classe própria (em vez de lógica solta dentro do consumer) para que a
 * cadeia de retry/DLQ/idempotência não precise saber nada sobre cache de
 * saldo/extrato — só sobre "rodar isso aqui e decidir o que fazer se
 * falhar".
 */
@Injectable()
export class TransactionEventsHandler {
  private readonly logger = new Logger(TransactionEventsHandler.name);

  constructor(private readonly walletsService: WalletsService) {}

  async handle(event: WalletEventMessage): Promise<void> {
    if (event.eventType !== 'transaction.completed') {
      this.logger.log(
        `Evento sem ação definida, ignorando: ${event.eventType}`,
      );
      return;
    }

    const payload = event.payload as TransactionCompletedPayload;
    await Promise.all([
      this.walletsService.invalidateWalletCaches(payload.originWalletId),
      this.walletsService.invalidateWalletCaches(payload.destinationWalletId),
    ]);
    this.logger.log(
      `Cache de saldo/extrato invalidado: carteiras ${payload.originWalletId} e ${payload.destinationWalletId}`,
    );
  }
}
