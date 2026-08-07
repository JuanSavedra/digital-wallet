import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { configureApp } from '../src/setup-app';

/**
 * Requer Postgres e Redis reais (`make up`). Cobre o item pendente do
 * Escopo 10: GET /transactions/:id só pode ser visto por quem participou
 * dela (origem ou destino), 404 se não existir.
 */
describe('GET /transactions/:id (e2e, infra real)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;
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
    const email = `tx-detail-${randomUUID()}@example.com`;
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

  it('lets the origin and the destination see the transaction, and 403s a third party', async () => {
    const origin = await createFundedUser(5_000n);
    const destination = await createFundedUser(0n);
    const outsider = await createFundedUser(0n);

    const transferResponse = await request(app.getHttpServer())
      .post('/api/v1/transactions/transfer')
      .set('Authorization', `Bearer ${origin.accessToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ destinationWalletId: destination.walletId, amount: 1_000 });
    expect(transferResponse.status).toBe(201);
    const transactionId = (transferResponse.body as { id: string }).id;

    const asOrigin = await request(app.getHttpServer())
      .get(`/api/v1/transactions/${transactionId}`)
      .set('Authorization', `Bearer ${origin.accessToken}`);
    expect(asOrigin.status).toBe(200);
    expect((asOrigin.body as { id: string }).id).toBe(transactionId);

    const asDestination = await request(app.getHttpServer())
      .get(`/api/v1/transactions/${transactionId}`)
      .set('Authorization', `Bearer ${destination.accessToken}`);
    expect(asDestination.status).toBe(200);

    const asOutsider = await request(app.getHttpServer())
      .get(`/api/v1/transactions/${transactionId}`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);
    expect(asOutsider.status).toBe(403);
  });

  it('returns 404 for a transaction id that does not exist', async () => {
    const user = await createFundedUser(0n);

    const response = await request(app.getHttpServer())
      .get(`/api/v1/transactions/${randomUUID()}`)
      .set('Authorization', `Bearer ${user.accessToken}`);

    expect(response.status).toBe(404);
  });
});
