import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Transaction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import { TransferDto } from './dto/transfer.dto';
import {
  ConcurrentModificationError,
  InsufficientBalanceError,
} from './errors/transfer.errors';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletsService: WalletsService,
  ) {}

  async transfer(
    userId: string,
    dto: TransferDto,
    idempotencyKey: string,
  ): Promise<Transaction> {
    const originWallet = await this.walletsService.findByUserId(userId);
    if (!originWallet) {
      throw new NotFoundException('Carteira de origem não encontrada');
    }

    const destinationWallet = await this.walletsService.findById(
      dto.destinationWalletId,
    );
    if (!destinationWallet) {
      throw new NotFoundException('Carteira de destino não encontrada');
    }

    if (originWallet.id === destinationWallet.id) {
      throw new BadRequestException(
        'Não é possível transferir para a própria carteira',
      );
    }

    const amount = BigInt(dto.amount);

    const pendingTransaction = await this.createPendingTransaction(
      originWallet.id,
      destinationWallet.id,
      amount,
      idempotencyKey,
    );
    if (pendingTransaction.alreadyProcessed) {
      return pendingTransaction.transaction;
    }

    const transaction = pendingTransaction.transaction;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const freshOrigin = await tx.wallet.findUniqueOrThrow({
          where: { id: originWallet.id },
        });

        if (freshOrigin.balance < amount) {
          throw new InsufficientBalanceError();
        }

        const debit = await tx.wallet.updateMany({
          where: { id: originWallet.id, version: freshOrigin.version },
          data: { balance: { decrement: amount }, version: { increment: 1 } },
        });
        if (debit.count !== 1) {
          throw new ConcurrentModificationError();
        }

        const freshDestination = await tx.wallet.findUniqueOrThrow({
          where: { id: destinationWallet.id },
        });
        const credit = await tx.wallet.updateMany({
          where: {
            id: destinationWallet.id,
            version: freshDestination.version,
          },
          data: { balance: { increment: amount }, version: { increment: 1 } },
        });
        if (credit.count !== 1) {
          throw new ConcurrentModificationError();
        }

        await tx.ledgerEntry.createMany({
          data: [
            {
              walletId: originWallet.id,
              transactionId: transaction.id,
              direction: 'DEBIT',
              amount,
            },
            {
              walletId: destinationWallet.id,
              transactionId: transaction.id,
              direction: 'CREDIT',
              amount,
            },
          ],
        });

        return tx.transaction.update({
          where: { id: transaction.id },
          data: { status: 'COMPLETED' },
        });
      });
    } catch (error) {
      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: { status: 'FAILED' },
      });

      if (error instanceof InsufficientBalanceError) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof ConcurrentModificationError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  private async createPendingTransaction(
    originWalletId: string,
    destinationWalletId: string,
    amount: bigint,
    idempotencyKey: string,
  ): Promise<{ transaction: Transaction; alreadyProcessed: boolean }> {
    try {
      const transaction = await this.prisma.transaction.create({
        data: {
          originWalletId,
          destinationWalletId,
          amount,
          idempotencyKey,
          status: 'PENDING',
        },
      });
      return { transaction, alreadyProcessed: false };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_CONSTRAINT_VIOLATION
      ) {
        return this.handleIdempotencyKeyReuse(idempotencyKey, originWalletId);
      }
      throw error;
    }
  }

  private async handleIdempotencyKeyReuse(
    idempotencyKey: string,
    requestingOriginWalletId: string,
  ): Promise<{ transaction: Transaction; alreadyProcessed: boolean }> {
    const existing = await this.prisma.transaction.findUnique({
      where: { idempotencyKey },
    });
    if (!existing) {
      // Corrida extrema: a chave colidiu e o outro registro já não existe mais.
      throw new ConflictException(
        'Conflito ao processar a chave de idempotência',
      );
    }

    if (existing.originWalletId !== requestingOriginWalletId) {
      throw new ConflictException(
        'Chave de idempotência já usada em outra operação',
      );
    }

    if (existing.status === 'COMPLETED') {
      return { transaction: existing, alreadyProcessed: true };
    }
    if (existing.status === 'PENDING') {
      throw new ConflictException('Operação ainda em processamento');
    }

    throw new ConflictException(
      'A tentativa anterior com esta chave falhou; use uma nova Idempotency-Key',
    );
  }
}
