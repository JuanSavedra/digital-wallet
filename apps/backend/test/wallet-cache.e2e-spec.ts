import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import type { AuthTokens } from '../src/auth/interfaces/token-payload.interface';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/cache/redis.service';
import { configureApp } from '../src/setup-app';
import { deleteLedgerEntries } from './utils/ledger-cleanup';
import { poll } from './utils/poll';

/**
 * Requer Postgres, Redis e RabbitMQ reais (`make up`). Prova o requisito
 * central do Escopo 9: o saldo/extrato exibidos nunca ficam "presos"
 * desatualizados depois de uma transferência, porque o consumidor do
 * evento (Escopo 8) invalida o cache de verdade — sem essa invalidação,
 * este teste pegaria o valor antigo (o TTL de segurança é de 30s, bem
 * maior que a janela do teste).
 */
describe('Wallet balance/statement cache (e2e, infra real)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let redisService: RedisService;
  const allEmails: string[] = [];
  const password = 'senha-forte-123';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    redisService = app.get(RedisService);
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { in: allEmails } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);
    const wallets = await prisma.wallet.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    });
    const walletIds = wallets.map((w) => w.id);
    const transactions = await prisma.transaction.findMany({
      where: { originWalletId: { in: walletIds } },
      select: { id: true },
    });
    const transactionIds = transactions.map((t) => t.id);
    await prisma.outboxEvent.deleteMany({
      where: { aggregateId: { in: transactionIds } },
    });
    await deleteLedgerEntries(prisma, { walletId: { in: walletIds } });
    await prisma.transaction.deleteMany({
      where: { originWalletId: { in: walletIds } },
    });
    await prisma.wallet.deleteMany({ where: { id: { in: walletIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  }, 15_000);

  async function registerAndLogin(initialBalanceCents: bigint) {
    const email = `wallet-cache-${randomUUID()}@example.com`;
    allEmails.push(email);
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password });
    const loginResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password });
    const { accessToken } = loginResponse.body as AuthTokens;

    const meResponse = await request(app.getHttpServer())
      .get('/api/v1/wallets/me')
      .set('Authorization', `Bearer ${accessToken}`);
    const walletId = (meResponse.body as { id: string }).id;

    await prisma.wallet.update({
      where: { id: walletId },
      data: { balance: initialBalanceCents },
    });
    // A chamada acima muda o banco por baixo do cache — limpa a entrada
    // que a requisição de /wallets/me já pode ter povoado com saldo 0.
    await redisService.del(`wallet:balance:${walletId}`);

    return { accessToken, walletId };
  }

  it('never serves a stale cached balance after a transfer completes', async () => {
    const origin = await registerAndLogin(10_000n);
    const destination = await registerAndLogin(0n);

    // Povoa o cache de propósito com o saldo pré-transferência.
    const beforeResponse = await request(app.getHttpServer())
      .get('/api/v1/wallets/me')
      .set('Authorization', `Bearer ${origin.accessToken}`);
    expect((beforeResponse.body as { balance: string }).balance).toBe('10000');

    await request(app.getHttpServer())
      .post('/api/v1/transactions/transfer')
      .set('Authorization', `Bearer ${origin.accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ destinationWalletId: destination.walletId, amount: 3_000 })
      .expect(201);

    // A invalidação acontece de forma assíncrona (via consumidor do
    // RabbitMQ), não no mesmo request/response da transferência — por
    // isso o polling em vez de checar uma vez só.
    await poll(
      async () => {
        const response = await request(app.getHttpServer())
          .get('/api/v1/wallets/me')
          .set('Authorization', `Bearer ${origin.accessToken}`);
        return (response.body as { balance: string }).balance;
      },
      (balance) => balance === '7000',
    );
  }, 15_000);

  it('invalidates the cached first statement page so the new entry shows up', async () => {
    const origin = await registerAndLogin(5_000n);
    const destination = await registerAndLogin(0n);

    // Povoa o cache do extrato (página 1) antes de a transação existir.
    const beforeStatement = await request(app.getHttpServer())
      .get('/api/v1/wallets/me/statement')
      .set('Authorization', `Bearer ${origin.accessToken}`);
    expect(
      (beforeStatement.body as { entries: unknown[] }).entries,
    ).toHaveLength(0);

    await request(app.getHttpServer())
      .post('/api/v1/transactions/transfer')
      .set('Authorization', `Bearer ${origin.accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ destinationWalletId: destination.walletId, amount: 1_000 })
      .expect(201);

    await poll(
      async () => {
        const response = await request(app.getHttpServer())
          .get('/api/v1/wallets/me/statement')
          .set('Authorization', `Bearer ${origin.accessToken}`);
        return (response.body as { entries: { direction: string }[] }).entries;
      },
      (entries) => entries.length === 1 && entries[0].direction === 'DEBIT',
    );
  }, 15_000);
});
