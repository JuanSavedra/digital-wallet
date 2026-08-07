import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Transaction } from '@prisma/client';
import {
  LockAcquisitionError,
  RedisLockService,
} from '../cache/redis-lock.service';
import { RequestContext } from '../common/context/request-context';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import { TransferDto } from './dto/transfer.dto';
import {
  ConcurrentModificationError,
  InsufficientBalanceError,
} from './errors/transfer.errors';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';
const WALLET_LOCK_TTL_MS = 5_000;
const walletLockKey = (walletId: string) => `lock:wallet:${walletId}`;

@Injectable()
export class TransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletsService: WalletsService,
    private readonly redisLockService: RedisLockService,
    private readonly metricsService: MetricsService,
  ) {}

  async transfer(
    userId: string,
    dto: TransferDto,
    idempotencyKey: string,
  ): Promise<Transaction> {
    const stopTimer = this.metricsService.startTransferTimer();
    try {
      return await this.doTransfer(userId, dto, idempotencyKey);
    } finally {
      stopTimer();
    }
  }

  private async doTransfer(
    userId: string,
    dto: TransferDto,
    idempotencyKey: string,
  ): Promise<Transaction> {
    const originWallet = await this.walletsService.findByUserId(userId);
    if (!originWallet) {
      this.metricsService.recordTransferError('not_found');
      throw new NotFoundException('Carteira de origem não encontrada');
    }

    const destinationWallet = await this.walletsService.findById(
      dto.destinationWalletId,
    );
    if (!destinationWallet) {
      this.metricsService.recordTransferError('not_found');
      throw new NotFoundException('Carteira de destino não encontrada');
    }

    if (originWallet.id === destinationWallet.id) {
      this.metricsService.recordTransferError('validation');
      throw new BadRequestException(
        'Não é possível transferir para a própria carteira',
      );
    }

    const amount = BigInt(dto.amount);

    try {
      // Lock distribuído por carteira, adquirido em ordem determinística
      // (ver RedisLockService) para não gerar deadlock entre transferências
      // concorrentes em sentidos opostos (A→B e B→A ao mesmo tempo). Isso
      // reduz a contenção sobre o lock otimista (coluna `version`, Escopo
      // 5) que continua sendo a garantia de correção de última instância —
      // mesmo que o lock do Redis expire ou falhe, o banco não deixa dois
      // débitos concorrentes corromperem o saldo.
      return await this.redisLockService.withLock(
        [walletLockKey(originWallet.id), walletLockKey(destinationWallet.id)],
        WALLET_LOCK_TTL_MS,
        () =>
          this.executeTransfer(
            originWallet.id,
            destinationWallet.id,
            amount,
            idempotencyKey,
          ),
      );
    } catch (error) {
      if (error instanceof LockAcquisitionError) {
        this.metricsService.recordTransferError('lock_conflict');
        throw new ConflictException(
          'Não foi possível processar a transferência agora, tente novamente',
        );
      }
      throw error;
    }
  }

  async findByIdForUser(
    transactionId: string,
    userId: string,
  ): Promise<Transaction> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { originWallet: true, destinationWallet: true },
    });
    if (!transaction) {
      throw new NotFoundException('Transação não encontrada');
    }

    const isParticipant =
      transaction.originWallet.userId === userId ||
      transaction.destinationWallet.userId === userId;
    if (!isParticipant) {
      throw new ForbiddenException('Você não tem acesso a esta transação');
    }

    return transaction;
  }

  private async executeTransfer(
    originWalletId: string,
    destinationWalletId: string,
    amount: bigint,
    idempotencyKey: string,
  ): Promise<Transaction> {
    const pendingTransaction = await this.createPendingTransaction(
      originWalletId,
      destinationWalletId,
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
          where: { id: originWalletId },
        });

        if (freshOrigin.balance < amount) {
          throw new InsufficientBalanceError();
        }

        const debit = await tx.wallet.updateMany({
          where: { id: originWalletId, version: freshOrigin.version },
          data: { balance: { decrement: amount }, version: { increment: 1 } },
        });
        if (debit.count !== 1) {
          throw new ConcurrentModificationError();
        }

        const freshDestination = await tx.wallet.findUniqueOrThrow({
          where: { id: destinationWalletId },
        });
        const credit = await tx.wallet.updateMany({
          where: {
            id: destinationWalletId,
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
              walletId: originWalletId,
              transactionId: transaction.id,
              direction: 'DEBIT',
              amount,
            },
            {
              walletId: destinationWalletId,
              transactionId: transaction.id,
              direction: 'CREDIT',
              amount,
            },
          ],
        });

        const completed = await tx.transaction.update({
          where: { id: transaction.id },
          data: { status: 'COMPLETED' },
        });

        // Outbox pattern: o evento só existe porque está na mesma
        // transação SQL do débito/crédito/ledger — se qualquer coisa acima
        // falhar, o rollback também desfaz este insert. Quem publica de
        // fato no RabbitMQ é o OutboxRelayService (Escopo 7 "relay").
        await tx.outboxEvent.create({
          data: {
            aggregateId: completed.id,
            eventType: 'transaction.completed',
            payload: {
              transactionId: completed.id,
              originWalletId,
              destinationWalletId,
              amount: amount.toString(),
              status: completed.status,
            },
            status: 'PENDING',
            correlationId: RequestContext.getCorrelationId(),
          },
        });

        return completed;
      });
    } catch (error) {
      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: { status: 'FAILED' },
      });

      if (error instanceof InsufficientBalanceError) {
        this.metricsService.recordTransferError('insufficient_balance');
        throw new BadRequestException(error.message);
      }
      if (error instanceof ConcurrentModificationError) {
        this.metricsService.recordTransferError('concurrent_modification');
        throw new ConflictException(error.message);
      }
      this.metricsService.recordTransferError('unexpected');
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
