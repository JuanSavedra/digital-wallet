import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as amqplib from 'amqplib';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { WALLET_EVENTS_EXCHANGE } from '../src/messaging/constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { configureApp } from '../src/setup-app';
import { deleteLedgerEntries } from './utils/ledger-cleanup';
import { poll } from './utils/poll';

/**
 * Requer Postgres, Redis e RabbitMQ reais (`make up`). Cobre o núcleo do
 * Escopo 7: o evento de outbox só existe porque a transação de negócio
 * persistiu (mesma transação SQL), e o relay realmente publica no
 * RabbitMQ — verificado consumindo a mensagem de uma fila de teste, não
 * só confiando que `waitForConfirms()` não lançou.
 */
describe('Outbox relay (e2e, infra real)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;
  let amqpConnection: amqplib.ChannelModel;
  let amqpChannel: amqplib.Channel;
  let testQueue: string;
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
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);

    amqpConnection = await amqplib.connect(
      configService.getOrThrow<string>('RABBITMQ_URL'),
    );
    amqpChannel = await amqpConnection.createChannel();
    await amqpChannel.assertExchange(WALLET_EVENTS_EXCHANGE, 'topic', {
      durable: true,
    });
    const { queue } = await amqpChannel.assertQueue('', {
      exclusive: true,
      autoDelete: true,
    });
    testQueue = queue;
    await amqpChannel.bindQueue(
      testQueue,
      WALLET_EVENTS_EXCHANGE,
      'transaction.completed',
    );
  });

  afterAll(async () => {
    await amqpChannel.close();
    await amqpConnection.close();

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

  async function createFundedUser(initialBalanceCents: bigint) {
    const email = `outbox-${randomUUID()}@example.com`;
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

  it('persists a PENDING outbox event transactionally and the relay actually publishes it to RabbitMQ', async () => {
    const origin = await createFundedUser(5_000n);
    const destination = await createFundedUser(0n);

    const transferResponse = await request(app.getHttpServer())
      .post('/api/v1/transactions/transfer')
      .set('Authorization', `Bearer ${origin.accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ destinationWalletId: destination.walletId, amount: 1_500 });
    expect(transferResponse.status).toBe(201);
    const transactionId = (transferResponse.body as { id: string }).id;

    const outboxEventRightAfter = await prisma.outboxEvent.findFirst({
      where: { aggregateId: transactionId },
    });
    expect(outboxEventRightAfter).not.toBeNull();
    expect(outboxEventRightAfter?.eventType).toBe('transaction.completed');

    // Consome a fila de teste ligada à exchange: só resolve quando a
    // mensagem chegar de verdade (não é só checar o status no banco).
    const delivered = await new Promise<amqplib.ConsumeMessage>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('timeout esperando a mensagem do relay')),
          8_000,
        );
        void amqpChannel.consume(
          testQueue,
          (msg) => {
            if (!msg) return;
            const content = JSON.parse(msg.content.toString()) as {
              aggregateId: string;
            };
            if (content.aggregateId === transactionId) {
              clearTimeout(timeout);
              amqpChannel.ack(msg);
              resolve(msg);
            } else {
              amqpChannel.ack(msg);
            }
          },
          { noAck: false },
        );
      },
    );

    const deliveredPayload = JSON.parse(delivered.content.toString()) as {
      aggregateId: string;
      eventType: string;
      payload: { amount: string; originWalletId: string };
    };
    expect(deliveredPayload.eventType).toBe('transaction.completed');
    expect(deliveredPayload.payload.amount).toBe('1500');
    expect(deliveredPayload.payload.originWalletId).toBe(origin.walletId);

    // A confirmação de entrega (acima) e o UPDATE que marca PUBLISHED no
    // banco são duas operações assíncronas separadas dentro do relay — a
    // mensagem pode chegar na fila de teste um instante antes desse
    // UPDATE terminar, então esperamos com um pequeno polling.
    const outboxEventAfterRelay = await poll(
      () =>
        prisma.outboxEvent.findFirst({ where: { aggregateId: transactionId } }),
      (event) => event?.status === 'PUBLISHED',
    );
    expect(outboxEventAfterRelay?.publishedAt).not.toBeNull();
  }, 15_000);
});
