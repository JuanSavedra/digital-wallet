import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { deleteLedgerEntries } from './utils/ledger-cleanup';

/**
 * Requer Postgres real rodando (ex.: `make up`) — valida o schema em si
 * (relações, unicidade, constraints de CHECK) direto via Prisma Client,
 * sem passar pela camada HTTP (ainda não existe lógica de negócio; isso é
 * só o Escopo 4, modelagem de dados).
 */
describe('Wallet/transaction schema (e2e, infra real)', () => {
  const prisma = new PrismaClient();
  const userAEmail = `schema-a-${randomUUID()}@example.com`;
  const userBEmail = `schema-b-${randomUUID()}@example.com`;
  let userAId: string;
  let userBId: string;
  let walletAId: string;
  let walletBId: string;

  beforeAll(async () => {
    const userA = await prisma.user.create({
      data: { email: userAEmail, passwordHash: 'hash' },
    });
    const userB = await prisma.user.create({
      data: { email: userBEmail, passwordHash: 'hash' },
    });
    userAId = userA.id;
    userBId = userB.id;

    const walletA = await prisma.wallet.create({
      data: { userId: userAId, balance: 10_000n },
    });
    const walletB = await prisma.wallet.create({
      data: { userId: userBId, balance: 0n },
    });
    walletAId = walletA.id;
    walletBId = walletB.id;
  });

  afterAll(async () => {
    await deleteLedgerEntries(prisma, {
      walletId: { in: [walletAId, walletBId] },
    });
    await prisma.transaction.deleteMany({
      where: { originWalletId: { in: [walletAId, walletBId] } },
    });
    await prisma.wallet.deleteMany({
      where: { id: { in: [walletAId, walletBId] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
    await prisma.$disconnect();
  });

  it('enforces one wallet per user (unique user_id)', async () => {
    await expect(
      prisma.wallet.create({ data: { userId: userAId, balance: 0n } }),
    ).rejects.toThrow();
  });

  it('rejects a negative wallet balance at the database level', async () => {
    await expect(
      prisma.wallet.update({
        where: { id: walletAId },
        data: { balance: -1n },
      }),
    ).rejects.toThrow();
  });

  it('creates a transaction with its two ledger entries (debit + credit)', async () => {
    const idempotencyKey = randomUUID();

    const transaction = await prisma.transaction.create({
      data: {
        originWalletId: walletAId,
        destinationWalletId: walletBId,
        amount: 2_500n,
        idempotencyKey,
        status: 'COMPLETED',
        ledgerEntries: {
          create: [
            { walletId: walletAId, direction: 'DEBIT', amount: 2_500n },
            { walletId: walletBId, direction: 'CREDIT', amount: 2_500n },
          ],
        },
      },
      include: { ledgerEntries: true },
    });

    expect(transaction.ledgerEntries).toHaveLength(2);
    expect(transaction.amount).toBe(2_500n);
  });

  it('rejects a duplicate idempotency key on transactions', async () => {
    const idempotencyKey = randomUUID();
    await prisma.transaction.create({
      data: {
        originWalletId: walletAId,
        destinationWalletId: walletBId,
        amount: 1_000n,
        idempotencyKey,
        status: 'COMPLETED',
      },
    });

    await expect(
      prisma.transaction.create({
        data: {
          originWalletId: walletAId,
          destinationWalletId: walletBId,
          amount: 1_000n,
          idempotencyKey,
          status: 'COMPLETED',
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a non-positive transaction amount', async () => {
    await expect(
      prisma.transaction.create({
        data: {
          originWalletId: walletAId,
          destinationWalletId: walletBId,
          amount: 0n,
          idempotencyKey: randomUUID(),
          status: 'COMPLETED',
        },
      }),
    ).rejects.toThrow();
  });

  it('records a pending outbox event for a transaction id', async () => {
    const transaction = await prisma.transaction.create({
      data: {
        originWalletId: walletAId,
        destinationWalletId: walletBId,
        amount: 500n,
        idempotencyKey: randomUUID(),
        status: 'COMPLETED',
      },
    });

    const event = await prisma.outboxEvent.create({
      data: {
        aggregateId: transaction.id,
        eventType: 'transaction.completed',
        payload: { transactionId: transaction.id },
        status: 'PENDING',
      },
    });

    expect(event.status).toBe('PENDING');
    expect(event.publishedAt).toBeNull();

    await prisma.outboxEvent.delete({ where: { id: event.id } });
  });
});
