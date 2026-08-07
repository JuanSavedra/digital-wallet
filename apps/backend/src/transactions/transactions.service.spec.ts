import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  LockAcquisitionError,
  RedisLockService,
} from '../cache/redis-lock.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import { TransactionsService } from './transactions.service';

function uniqueConstraintError() {
  return new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: '6.19.3',
  });
}

describe('TransactionsService', () => {
  let service: TransactionsService;
  let walletsService: jest.Mocked<WalletsService>;
  let redisLockService: jest.Mocked<RedisLockService>;
  let prisma: {
    transaction: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  let tx: {
    wallet: Record<string, jest.Mock>;
    ledgerEntry: Record<string, jest.Mock>;
    transaction: Record<string, jest.Mock>;
    outboxEvent: Record<string, jest.Mock>;
  };

  const origin = {
    id: 'wallet-origin',
    userId: 'user-1',
    balance: 10_000n,
    version: 0,
  };
  const destination = {
    id: 'wallet-destination',
    userId: 'user-2',
    balance: 0n,
    version: 0,
  };
  const dto = { destinationWalletId: destination.id, amount: 2_500 };
  const idempotencyKey = 'a2f3b4c5-d6e7-4890-ab12-cd34ef567890';

  beforeEach(() => {
    tx = {
      wallet: { findUniqueOrThrow: jest.fn(), updateMany: jest.fn() },
      ledgerEntry: { createMany: jest.fn() },
      transaction: { update: jest.fn() },
      outboxEvent: { create: jest.fn() },
    };

    prisma = {
      transaction: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
        callback(tx),
      ),
    };

    walletsService = {
      findByUserId: jest.fn(),
      findById: jest.fn(),
    } as unknown as jest.Mocked<WalletsService>;

    redisLockService = {
      withLock: jest.fn((_keys: string[], _ttl: number, fn: () => unknown) =>
        fn(),
      ),
    } as unknown as jest.Mocked<RedisLockService>;

    service = new TransactionsService(
      prisma as unknown as PrismaService,
      walletsService,
      redisLockService,
    );
  });

  it('completes a transfer, debiting origin and crediting destination', async () => {
    walletsService.findByUserId.mockResolvedValue(origin as never);
    walletsService.findById.mockResolvedValue(destination as never);
    prisma.transaction.create.mockResolvedValue({
      id: 'tx-1',
      status: 'PENDING',
    });
    tx.wallet.findUniqueOrThrow
      .mockResolvedValueOnce(origin)
      .mockResolvedValueOnce(destination);
    tx.wallet.updateMany.mockResolvedValue({ count: 1 });
    tx.transaction.update.mockResolvedValue({
      id: 'tx-1',
      status: 'COMPLETED',
    });

    const result = await service.transfer(origin.userId, dto, idempotencyKey);

    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: {
        originWalletId: origin.id,
        destinationWalletId: destination.id,
        amount: 2_500n,
        idempotencyKey,
        status: 'PENDING',
      },
    });
    expect(tx.ledgerEntry.createMany).toHaveBeenCalledWith({
      data: [
        {
          walletId: origin.id,
          transactionId: 'tx-1',
          direction: 'DEBIT',
          amount: 2_500n,
        },
        {
          walletId: destination.id,
          transactionId: 'tx-1',
          direction: 'CREDIT',
          amount: 2_500n,
        },
      ],
    });
    expect(result).toEqual({ id: 'tx-1', status: 'COMPLETED' });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        aggregateId: 'tx-1',
        eventType: 'transaction.completed',
        payload: {
          transactionId: 'tx-1',
          originWalletId: origin.id,
          destinationWalletId: destination.id,
          amount: '2500',
          status: 'COMPLETED',
        },
        status: 'PENDING',
      },
    });
    // A ordenação determinística das chaves acontece dentro do
    // RedisLockService (testado em redis-lock.service.spec.ts); aqui só
    // importa que o service passe as duas chaves de carteira envolvidas.
    expect(redisLockService.withLock).toHaveBeenCalledWith(
      ['lock:wallet:wallet-origin', 'lock:wallet:wallet-destination'],
      5_000,
      expect.any(Function),
    );
  });

  it('rejects with 409 when the wallet lock cannot be acquired', async () => {
    walletsService.findByUserId.mockResolvedValue(origin as never);
    walletsService.findById.mockResolvedValue(destination as never);
    redisLockService.withLock.mockRejectedValue(
      new LockAcquisitionError('lock:wallet:wallet-origin'),
    );

    await expect(
      service.transfer(origin.userId, dto, idempotencyKey),
    ).rejects.toThrow(ConflictException);
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the requester has no wallet', async () => {
    walletsService.findByUserId.mockResolvedValue(null);

    await expect(
      service.transfer('user-without-wallet', dto, idempotencyKey),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when the destination wallet does not exist', async () => {
    walletsService.findByUserId.mockResolvedValue(origin as never);
    walletsService.findById.mockResolvedValue(null);

    await expect(
      service.transfer(origin.userId, dto, idempotencyKey),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects a transfer to the same wallet', async () => {
    walletsService.findByUserId.mockResolvedValue(origin as never);
    walletsService.findById.mockResolvedValue(origin as never);

    await expect(
      service.transfer(
        origin.userId,
        { ...dto, destinationWalletId: origin.id },
        idempotencyKey,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('marks the transaction FAILED and rejects with 400 on insufficient balance', async () => {
    walletsService.findByUserId.mockResolvedValue(origin as never);
    walletsService.findById.mockResolvedValue(destination as never);
    prisma.transaction.create.mockResolvedValue({
      id: 'tx-1',
      status: 'PENDING',
    });
    tx.wallet.findUniqueOrThrow.mockResolvedValueOnce({
      ...origin,
      balance: 100n,
    });

    await expect(
      service.transfer(origin.userId, dto, idempotencyKey),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx-1' },
      data: { status: 'FAILED' },
    });
  });

  it('marks the transaction FAILED and rejects with 409 on a lost optimistic-lock update', async () => {
    walletsService.findByUserId.mockResolvedValue(origin as never);
    walletsService.findById.mockResolvedValue(destination as never);
    prisma.transaction.create.mockResolvedValue({
      id: 'tx-1',
      status: 'PENDING',
    });
    tx.wallet.findUniqueOrThrow.mockResolvedValueOnce(origin);
    tx.wallet.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.transfer(origin.userId, dto, idempotencyKey),
    ).rejects.toThrow(ConflictException);
    expect(prisma.transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx-1' },
      data: { status: 'FAILED' },
    });
  });

  describe('idempotency key reuse (unique constraint on insert)', () => {
    beforeEach(() => {
      walletsService.findByUserId.mockResolvedValue(origin as never);
      walletsService.findById.mockResolvedValue(destination as never);
      prisma.transaction.create.mockRejectedValue(uniqueConstraintError());
    });

    it('replays the cached result for an already-completed transaction with the same origin', async () => {
      const existing = {
        id: 'tx-1',
        originWalletId: origin.id,
        status: 'COMPLETED',
      };
      prisma.transaction.findUnique.mockResolvedValue(existing);

      const result = await service.transfer(origin.userId, dto, idempotencyKey);

      expect(result).toEqual(existing);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects with 409 when the key belongs to a different origin wallet', async () => {
      prisma.transaction.findUnique.mockResolvedValue({
        id: 'tx-1',
        originWalletId: 'someone-elses-wallet',
        status: 'COMPLETED',
      });

      await expect(
        service.transfer(origin.userId, dto, idempotencyKey),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects with 409 while the original request is still PENDING', async () => {
      prisma.transaction.findUnique.mockResolvedValue({
        id: 'tx-1',
        originWalletId: origin.id,
        status: 'PENDING',
      });

      await expect(
        service.transfer(origin.userId, dto, idempotencyKey),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects with 409 telling the client to use a new key when the original attempt failed', async () => {
      prisma.transaction.findUnique.mockResolvedValue({
        id: 'tx-1',
        originWalletId: origin.id,
        status: 'FAILED',
      });

      await expect(
        service.transfer(origin.userId, dto, idempotencyKey),
      ).rejects.toThrow(ConflictException);
    });
  });
});
