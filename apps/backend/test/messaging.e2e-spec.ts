import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as amqplib from 'amqplib';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import {
  TRANSACTION_COMPLETED_ROUTING_KEY,
  WALLET_EVENTS_EXCHANGE,
} from '../src/messaging/constants';
import { WalletEventMessage } from '../src/messaging/interfaces/wallet-event.interface';
import { TransactionEventsHandler } from '../src/messaging/transaction-events.handler';
import { PrismaService } from '../src/prisma/prisma.service';
import { configureApp } from '../src/setup-app';
import { poll } from './utils/poll';

/**
 * Requer Postgres, Redis e RabbitMQ reais (`make up`). Substitui o
 * TransactionEventsHandler por um mock controlável para exercitar retry,
 * DLQ e reprocessamento manual de verdade (broker real, atrasos reais) —
 * não dá pra testar isso só com mocks de unidade.
 */
describe('Messaging: retry, DLQ e idempotência do consumidor (e2e, infra real)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;
  const allEmails: string[] = [];
  const password = 'senha-forte-123';

  const callCounts = new Map<string, number>();
  const failUntilAttempt = new Map<string, number>();
  const handlerMock: Pick<TransactionEventsHandler, 'handle'> = {
    handle: jest.fn((event: WalletEventMessage) => {
      const count = (callCounts.get(event.aggregateId) ?? 0) + 1;
      callCounts.set(event.aggregateId, count);
      const failCount = failUntilAttempt.get(event.aggregateId) ?? 0;
      if (count <= failCount) {
        return Promise.reject(
          new Error('falha simulada para teste de retry/DLQ'),
        );
      }
      return Promise.resolve();
    }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(TransactionEventsHandler)
      .useValue(handlerMock)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);
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
    await prisma.ledgerEntry.deleteMany({
      where: { walletId: { in: walletIds } },
    });
    await prisma.transaction.deleteMany({
      where: { originWalletId: { in: walletIds } },
    });
    await prisma.wallet.deleteMany({ where: { id: { in: walletIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  }, 15_000);

  async function createFundedUser(initialBalanceCents: bigint) {
    const email = `messaging-${randomUUID()}@example.com`;
    allEmails.push(email);
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password });

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const wallet = await prisma.wallet.update({
      where: { userId: user.id },
      data: { balance: initialBalanceCents },
    });

    const accessToken = await jwtService.signAsync(
      { sub: user.id, email: user.email },
      { secret: configService.getOrThrow<string>('JWT_ACCESS_SECRET') },
    );

    return { accessToken, walletId: wallet.id };
  }

  async function makeTransfer(): Promise<string> {
    const origin = await createFundedUser(5_000n);
    const destination = await createFundedUser(0n);

    const response = await request(app.getHttpServer())
      .post('/api/v1/transactions/transfer')
      .set('Authorization', `Bearer ${origin.accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ destinationWalletId: destination.walletId, amount: 1_000 });
    expect(response.status).toBe(201);

    return (response.body as { id: string }).id;
  }

  it('retries a failing event and eventually succeeds within the retry limit', async () => {
    const transactionId = await makeTransfer();
    failUntilAttempt.set(transactionId, 2); // falha 2x, sucesso na 3ª tentativa

    await poll(
      () => Promise.resolve(callCounts.get(transactionId) ?? 0),
      (count) => count >= 3,
    );

    // Dá tempo de qualquer retry indevido acontecer antes de conferir
    // que parou exatamente em 3 tentativas (não foi parar na DLQ).
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(callCounts.get(transactionId)).toBe(3);
  }, 15_000);

  it('moves a permanently-failing event to the DLQ, and the admin endpoint can replay it', async () => {
    const transactionId = await makeTransfer();
    failUntilAttempt.set(transactionId, Number.POSITIVE_INFINITY);

    const admin = await createFundedUser(0n);

    await poll(
      async () => {
        const response = await request(app.getHttpServer())
          .get('/api/v1/admin/dlq')
          .set('Authorization', `Bearer ${admin.accessToken}`);
        return (response.body as { messageCount: number }).messageCount;
      },
      (count) => count >= 1,
    );

    const attemptsBeforeReplay = callCounts.get(transactionId) ?? 0;
    expect(attemptsBeforeReplay).toBe(4); // 1 inicial + 3 retries

    // Permite que a próxima tentativa (a do replay) tenha sucesso.
    failUntilAttempt.set(transactionId, 0);

    const replayResponse = await request(app.getHttpServer())
      .post('/api/v1/admin/dlq/replay')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(replayResponse.status).toBe(201);
    expect(
      (replayResponse.body as { replayed: number }).replayed,
    ).toBeGreaterThanOrEqual(0);

    await poll(
      () => Promise.resolve(callCounts.get(transactionId) ?? 0),
      (count) => count > attemptsBeforeReplay,
    );

    await poll(
      async () => {
        const response = await request(app.getHttpServer())
          .get('/api/v1/admin/dlq')
          .set('Authorization', `Bearer ${admin.accessToken}`);
        return (response.body as { messageCount: number }).messageCount;
      },
      (count) => count === 0,
    );
  }, 20_000);

  it('does not process the same event twice when it is redelivered (consumer-side idempotency)', async () => {
    const transactionId = await makeTransfer();

    await poll(
      () => Promise.resolve(callCounts.get(transactionId) ?? 0),
      (count) => count >= 1,
    );
    expect(callCounts.get(transactionId)).toBe(1);

    const outboxEvent = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: transactionId },
    });

    // Simula uma redelivery "at-least-once" publicando de novo a
    // mesma mensagem (mesmo id de evento) diretamente na exchange.
    const connection = await amqplib.connect(
      configService.getOrThrow<string>('RABBITMQ_URL'),
    );
    const channel = await connection.createChannel();
    channel.publish(
      WALLET_EVENTS_EXCHANGE,
      TRANSACTION_COMPLETED_ROUTING_KEY,
      Buffer.from(
        JSON.stringify({
          id: outboxEvent.id,
          aggregateId: outboxEvent.aggregateId,
          eventType: outboxEvent.eventType,
          payload: outboxEvent.payload,
        }),
      ),
      { persistent: true },
    );
    await channel.close();
    await connection.close();

    // Espera um tempo razoável pra garantir que, se fosse processar de
    // novo, já teria processado — e confirma que NÃO processou.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(callCounts.get(transactionId)).toBe(1);
  }, 15_000);
});
