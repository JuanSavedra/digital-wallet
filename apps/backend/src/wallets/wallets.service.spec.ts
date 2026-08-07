import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from './wallets.service';

describe('WalletsService', () => {
  let walletsService: WalletsService;
  let prisma: { wallet: Record<string, jest.Mock> };

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
      },
    };
    walletsService = new WalletsService(prisma as unknown as PrismaService);
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
});
