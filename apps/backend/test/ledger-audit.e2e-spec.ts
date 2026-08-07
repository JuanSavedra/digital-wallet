import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { deleteLedgerEntries } from './utils/ledger-cleanup';

/**
 * Escopo 13 — auditoria do livro-razão, validada direto no Postgres (é lá
 * que as garantias vivem, não na camada de aplicação).
 *
 * Requer Postgres real rodando (`make up`).
 */
describe('Ledger — append-only e integridade (e2e, Postgres real)', () => {
  const prisma = new PrismaClient();

  let userId: string;
  let walletId: string;
  let transactionId: string;
  let depositId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `ledger-audit-${randomUUID()}@example.com`,
        passwordHash: 'hash',
      },
    });
    userId = user.id;

    const wallet = await prisma.wallet.create({
      data: { userId, balance: 0n },
    });
    walletId = wallet.id;

    const other = await prisma.wallet.create({
      data: {
        balance: 0n,
        user: {
          create: {
            email: `ledger-audit-dst-${randomUUID()}@example.com`,
            passwordHash: 'hash',
          },
        },
      },
    });

    const transaction = await prisma.transaction.create({
      data: {
        originWalletId: walletId,
        destinationWalletId: other.id,
        amount: 500n,
        idempotencyKey: randomUUID(),
        status: 'COMPLETED',
      },
    });
    transactionId = transaction.id;

    const deposit = await prisma.walletDeposit.create({
      data: {
        walletId,
        amount: 1_000n,
        providerChargeId: `charge_${randomUUID()}`,
        checkoutUrl: 'https://pay.example/x',
        status: 'PAID',
        paidAt: new Date(),
      },
    });
    depositId = deposit.id;
  });

  afterAll(async () => {
    await deleteLedgerEntries(prisma, { walletId });
    await prisma.transaction.deleteMany({ where: { id: transactionId } });
    await prisma.walletDeposit.deleteMany({ where: { id: depositId } });
    const wallets = await prisma.wallet.findMany({
      where: { user: { email: { contains: 'ledger-audit-' } } },
      select: { id: true, userId: true },
    });
    await prisma.wallet.deleteMany({
      where: { id: { in: wallets.map((w) => w.id) } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [userId, ...wallets.map((w) => w.userId)] } },
    });
    await prisma.$disconnect();
  });

  it('aceita um lançamento vindo de uma transferência', async () => {
    const entry = await prisma.ledgerEntry.create({
      data: { walletId, transactionId, direction: 'DEBIT', amount: 500n },
    });

    expect(entry.transactionId).toBe(transactionId);
    expect(entry.depositId).toBeNull();
  });

  it('aceita um lançamento vindo de um depósito', async () => {
    const entry = await prisma.ledgerEntry.create({
      data: { walletId, depositId, direction: 'CREDIT', amount: 1_000n },
    });

    expect(entry.depositId).toBe(depositId);
    expect(entry.transactionId).toBeNull();
  });

  it('recusa um lançamento órfão, sem transação nem depósito', async () => {
    // Todo lançamento precisa de origem rastreável — é o que torna o razão
    // auditável.
    await expect(
      prisma.ledgerEntry.create({
        data: { walletId, direction: 'CREDIT', amount: 100n },
      }),
    ).rejects.toThrow();
  });

  it('recusa um lançamento com transação E depósito ao mesmo tempo', async () => {
    await expect(
      prisma.ledgerEntry.create({
        data: {
          walletId,
          transactionId,
          depositId,
          direction: 'CREDIT',
          amount: 100n,
        },
      }),
    ).rejects.toThrow();
  });

  describe('imutabilidade (append-only)', () => {
    let entryId: string;

    beforeAll(async () => {
      const entry = await prisma.ledgerEntry.create({
        data: { walletId, transactionId, direction: 'CREDIT', amount: 777n },
      });
      entryId = entry.id;
    });

    it('bloqueia UPDATE de um lançamento no próprio banco', async () => {
      // Reescrever o valor de um lançamento é exatamente como se apaga o
      // rastro de uma fraude — a trigger impede isso mesmo com acesso
      // direto ao banco, não só pela camada de aplicação.
      await expect(
        prisma.ledgerEntry.update({
          where: { id: entryId },
          data: { amount: 1n },
        }),
      ).rejects.toThrow(/append-only/i);

      const untouched = await prisma.ledgerEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(untouched.amount).toBe(777n);
    });

    it('bloqueia DELETE de um lançamento no próprio banco', async () => {
      await expect(
        prisma.ledgerEntry.delete({ where: { id: entryId } }),
      ).rejects.toThrow(/append-only/i);

      expect(
        await prisma.ledgerEntry.findUnique({ where: { id: entryId } }),
      ).not.toBeNull();
    });

    it('só permite a remoção sob a flag explícita de manutenção', async () => {
      await deleteLedgerEntries(prisma, { id: entryId });

      expect(
        await prisma.ledgerEntry.findUnique({ where: { id: entryId } }),
      ).toBeNull();
    });
  });
});
