import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AbacatePayService } from '../payments/abacatepay.service';
import { PrismaService } from '../prisma/prisma.service';
import { DepositsService } from './deposits.service';
import { WalletsService } from './wallets.service';

describe('DepositsService', () => {
  let service: DepositsService;
  let abacatePayService: jest.Mocked<AbacatePayService>;
  let walletsService: jest.Mocked<WalletsService>;
  let configService: { getOrThrow: jest.Mock };
  let prisma: {
    walletDeposit: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  let tx: {
    walletDeposit: Record<string, jest.Mock>;
    wallet: Record<string, jest.Mock>;
    ledgerEntry: Record<string, jest.Mock>;
  };

  const wallet = { id: 'wallet-1', userId: 'user-1', balance: 5_000n };

  const pendingDeposit = {
    id: 'deposit-1',
    walletId: wallet.id,
    amount: 10_000n,
    provider: 'abacatepay',
    providerChargeId: 'checkout_1',
    providerProductId: 'prod_1',
    checkoutUrl: 'https://pay.example/checkout_1',
    status: 'PENDING',
    createdAt: new Date(),
    paidAt: null,
    wallet,
  };

  beforeEach(() => {
    tx = {
      walletDeposit: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
      wallet: { update: jest.fn() },
      ledgerEntry: { create: jest.fn() },
    };

    prisma = {
      walletDeposit: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
        callback(tx),
      ),
    };

    abacatePayService = {
      createProduct: jest.fn(),
      createPixCheckout: jest.fn(),
      findCheckoutById: jest.fn(),
    } as unknown as jest.Mocked<AbacatePayService>;

    walletsService = {
      findByUserId: jest.fn(),
      invalidateWalletCaches: jest.fn(),
    } as unknown as jest.Mocked<WalletsService>;

    configService = {
      getOrThrow: jest.fn().mockReturnValue('http://localhost:5173'),
    };

    service = new DepositsService(
      prisma as unknown as PrismaService,
      abacatePayService,
      walletsService,
      configService as unknown as ConfigService,
    );
  });

  describe('createDeposit', () => {
    it('creates a product and a PIX checkout, persisting a PENDING deposit', async () => {
      walletsService.findByUserId.mockResolvedValue(wallet as never);
      abacatePayService.createProduct.mockResolvedValue({ id: 'prod_1' });
      abacatePayService.createPixCheckout.mockResolvedValue({
        id: 'checkout_1',
        url: 'https://pay.example/checkout_1',
        status: 'PENDING',
      });
      prisma.walletDeposit.create.mockResolvedValue(pendingDeposit);

      const result = await service.createDeposit(wallet.userId, 10_000);

      expect(abacatePayService.createProduct).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        10_000,
      );
      expect(abacatePayService.createPixCheckout).toHaveBeenCalledWith(
        'prod_1',
        expect.stringMatching(
          /^http:\/\/localhost:5173\/deposits\/callback\?depositId=.+$/,
        ),
        expect.stringMatching(
          /^http:\/\/localhost:5173\/deposits\/callback\?depositId=.+$/,
        ),
      );
      expect(prisma.walletDeposit.create).toHaveBeenCalledWith({
        data: {
          id: expect.any(String),
          walletId: wallet.id,
          amount: 10_000n,
          providerChargeId: 'checkout_1',
          providerProductId: 'prod_1',
          checkoutUrl: 'https://pay.example/checkout_1',
          status: 'PENDING',
        },
      });
      expect(result).toBe(pendingDeposit);
    });

    it('throws NotFoundException when the user has no wallet', async () => {
      walletsService.findByUserId.mockResolvedValue(null);

      await expect(service.createDeposit('nobody', 10_000)).rejects.toThrow(
        NotFoundException,
      );
      expect(abacatePayService.createProduct).not.toHaveBeenCalled();
    });
  });

  describe('getDepositForUser', () => {
    it('throws NotFoundException when the deposit does not exist', async () => {
      prisma.walletDeposit.findUnique.mockResolvedValue(null);

      await expect(
        service.getDepositForUser('missing', wallet.userId),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when the deposit belongs to another user', async () => {
      prisma.walletDeposit.findUnique.mockResolvedValue(pendingDeposit);

      await expect(
        service.getDepositForUser(pendingDeposit.id, 'someone-else'),
      ).rejects.toThrow(ForbiddenException);
      expect(abacatePayService.findCheckoutById).not.toHaveBeenCalled();
    });

    it('returns the deposit as-is when already PAID, without re-checking the provider', async () => {
      const paid = { ...pendingDeposit, status: 'PAID', paidAt: new Date() };
      prisma.walletDeposit.findUnique.mockResolvedValue(paid);

      const result = await service.getDepositForUser(paid.id, wallet.userId);

      expect(result).toBe(paid);
      expect(abacatePayService.findCheckoutById).not.toHaveBeenCalled();
    });

    it('returns the deposit unchanged while the provider still reports PENDING', async () => {
      prisma.walletDeposit.findUnique.mockResolvedValue(pendingDeposit);
      abacatePayService.findCheckoutById.mockResolvedValue({
        id: 'checkout_1',
        url: pendingDeposit.checkoutUrl,
        status: 'PENDING',
      });

      const result = await service.getDepositForUser(
        pendingDeposit.id,
        wallet.userId,
      );

      expect(result).toBe(pendingDeposit);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('marks the deposit EXPIRED/CANCELLED when the provider reports a terminal non-paid status', async () => {
      prisma.walletDeposit.findUnique.mockResolvedValue(pendingDeposit);
      abacatePayService.findCheckoutById.mockResolvedValue({
        id: 'checkout_1',
        url: pendingDeposit.checkoutUrl,
        status: 'CANCELLED',
      });
      prisma.walletDeposit.update.mockResolvedValue({
        ...pendingDeposit,
        status: 'CANCELLED',
      });

      const result = await service.getDepositForUser(
        pendingDeposit.id,
        wallet.userId,
      );

      expect(prisma.walletDeposit.update).toHaveBeenCalledWith({
        where: { id: pendingDeposit.id },
        data: { status: 'CANCELLED' },
      });
      expect(result.status).toBe('CANCELLED');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('credits the wallet exactly once when the provider reports PAID (idempotent confirm)', async () => {
      prisma.walletDeposit.findUnique.mockResolvedValue(pendingDeposit);
      abacatePayService.findCheckoutById.mockResolvedValue({
        id: 'checkout_1',
        url: pendingDeposit.checkoutUrl,
        status: 'PAID',
      });
      tx.walletDeposit.updateMany.mockResolvedValue({ count: 1 });
      tx.walletDeposit.findUniqueOrThrow.mockResolvedValue({
        ...pendingDeposit,
        status: 'PAID',
        paidAt: new Date(),
      });

      const result = await service.getDepositForUser(
        pendingDeposit.id,
        wallet.userId,
      );

      expect(tx.walletDeposit.updateMany).toHaveBeenCalledWith({
        where: { id: pendingDeposit.id, status: 'PENDING' },
        data: { status: 'PAID', paidAt: expect.any(Date) },
      });
      expect(tx.wallet.update).toHaveBeenCalledWith({
        where: { id: wallet.id },
        data: {
          balance: { increment: pendingDeposit.amount },
          version: { increment: 1 },
        },
      });
      // O crédito e o lançamento no razão saem da mesma transação SQL: é o
      // que sustenta o invariante saldo == soma dos lançamentos.
      expect(tx.ledgerEntry.create).toHaveBeenCalledWith({
        data: {
          walletId: wallet.id,
          depositId: pendingDeposit.id,
          direction: 'CREDIT',
          amount: pendingDeposit.amount,
        },
      });
      expect(walletsService.invalidateWalletCaches).toHaveBeenCalledWith(
        wallet.id,
      );
      expect(result.status).toBe('PAID');
    });

    it('does not double-credit when the deposit was already confirmed concurrently', async () => {
      prisma.walletDeposit.findUnique.mockResolvedValue(pendingDeposit);
      abacatePayService.findCheckoutById.mockResolvedValue({
        id: 'checkout_1',
        url: pendingDeposit.checkoutUrl,
        status: 'PAID',
      });
      // Outra checagem concorrente já ganhou a corrida e mudou o status.
      tx.walletDeposit.updateMany.mockResolvedValue({ count: 0 });
      tx.walletDeposit.findUniqueOrThrow.mockResolvedValue({
        ...pendingDeposit,
        status: 'PAID',
        paidAt: new Date(),
      });

      await service.getDepositForUser(pendingDeposit.id, wallet.userId);

      expect(tx.wallet.update).not.toHaveBeenCalled();
      expect(walletsService.invalidateWalletCaches).toHaveBeenCalledWith(
        wallet.id,
      );
    });
  });
});
