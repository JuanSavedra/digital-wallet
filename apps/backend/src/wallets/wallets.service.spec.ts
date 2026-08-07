import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RedisService } from '../cache/redis.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from './wallets.service';

describe('WalletsService', () => {
  let walletsService: WalletsService;
  let prisma: {
    wallet: Record<string, jest.Mock>;
    ledgerEntry: Record<string, jest.Mock>;
  };
  let redisService: jest.Mocked<RedisService>;

  const wallet = {
    id: 'wallet-1',
    userId: 'user-1',
    balance: 0n,
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    prisma = {
      wallet: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      ledgerEntry: { findMany: jest.fn() },
    };
    redisService = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    } as unknown as jest.Mocked<RedisService>;
    walletsService = new WalletsService(
      prisma as unknown as PrismaService,
      redisService,
    );
  });

  it('createForUser creates a wallet with zero balance', async () => {
    prisma.wallet.create.mockResolvedValue(wallet);

    await walletsService.createForUser('user-1');

    expect(prisma.wallet.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', balance: 0n },
    });
  });

  it('findByUserId delegates to prisma.wallet.findUnique by userId', async () => {
    prisma.wallet.findUnique.mockResolvedValue(wallet);

    const result = await walletsService.findByUserId('user-1');

    expect(prisma.wallet.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
    expect(result).toEqual(wallet);
  });

  describe('assertOwnership', () => {
    it('returns the wallet when it belongs to the user', async () => {
      prisma.wallet.findUnique.mockResolvedValue(wallet);

      const result = await walletsService.assertOwnership('wallet-1', 'user-1');

      expect(result).toEqual(wallet);
    });

    it('throws NotFoundException when the wallet does not exist', async () => {
      prisma.wallet.findUnique.mockResolvedValue(null);

      await expect(
        walletsService.assertOwnership('missing', 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when the wallet belongs to another user', async () => {
      prisma.wallet.findUnique.mockResolvedValue(wallet);

      await expect(
        walletsService.assertOwnership('wallet-1', 'someone-else'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getCachedBalance', () => {
    it('returns the cached value without hitting the database on a hit', async () => {
      redisService.get.mockResolvedValue('5000');

      const balance = await walletsService.getCachedBalance('wallet-1');

      expect(balance).toBe(5000n);
      expect(prisma.wallet.findUniqueOrThrow).not.toHaveBeenCalled();
    });

    it('reads from the database and populates the cache on a miss', async () => {
      redisService.get.mockResolvedValue(null);
      prisma.wallet.findUniqueOrThrow.mockResolvedValue({
        ...wallet,
        balance: 1_234n,
      });

      const balance = await walletsService.getCachedBalance('wallet-1');

      expect(balance).toBe(1_234n);
      expect(redisService.set).toHaveBeenCalledWith(
        'wallet:balance:wallet-1',
        '1234',
        expect.any(Number),
      );
    });
  });

  describe('getStatement', () => {
    it('returns the cached page without hitting the database on a hit', async () => {
      const cachedEntries = [
        {
          id: 'entry-1',
          transactionId: 'tx-1',
          direction: 'DEBIT',
          amount: '500',
          createdAt: new Date().toISOString(),
        },
      ];
      redisService.get.mockResolvedValue(JSON.stringify(cachedEntries));

      const entries = await walletsService.getStatement('wallet-1', 1);

      expect(entries).toEqual(cachedEntries);
      expect(prisma.ledgerEntry.findMany).not.toHaveBeenCalled();
    });

    it('reads from the database, serializes BigInt amounts and populates the cache on a miss', async () => {
      redisService.get.mockResolvedValue(null);
      prisma.ledgerEntry.findMany.mockResolvedValue([
        {
          id: 'entry-1',
          transactionId: 'tx-1',
          direction: 'DEBIT',
          amount: 500n,
          createdAt: new Date('2026-01-01'),
        },
      ]);

      const entries = await walletsService.getStatement('wallet-1', 1);

      expect(entries).toEqual([
        expect.objectContaining({ id: 'entry-1', amount: '500' }),
      ]);
      expect(redisService.set).toHaveBeenCalledWith(
        'wallet:statement:wallet-1:page:1',
        expect.any(String),
        expect.any(Number),
      );
    });
  });

  describe('invalidateWalletCaches', () => {
    it('deletes both the balance and the first statement page from the cache', async () => {
      await walletsService.invalidateWalletCaches('wallet-1');

      expect(redisService.del).toHaveBeenCalledWith('wallet:balance:wallet-1');
      expect(redisService.del).toHaveBeenCalledWith(
        'wallet:statement:wallet-1:page:1',
      );
    });
  });
});
