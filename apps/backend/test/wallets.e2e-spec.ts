import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import type { AuthTokens } from '../src/auth/interfaces/token-payload.interface';
import { PrismaService } from '../src/prisma/prisma.service';
import { configureApp } from '../src/setup-app';

/**
 * Requer Postgres e Redis reais (`make up`). Cobre o auto-provisionamento
 * de carteira no registro e o guard de propriedade (WalletOwnerGuard),
 * fechando o item pendente do Escopo 3.
 */
describe('Wallets ownership (e2e, infra real)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const userAEmail = `wallets-a-${randomUUID()}@example.com`;
  const userBEmail = `wallets-b-${randomUUID()}@example.com`;
  const password = 'senha-forte-123';
  const allEmails = [userAEmail, userBEmail];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { in: allEmails } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  async function registerAndLogin(email: string) {
    allEmails.push(email);
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password });
    const loginResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password });
    return (loginResponse.body as AuthTokens).accessToken;
  }

  it('auto-provisions a wallet with zero balance on registration', async () => {
    const accessToken = await registerAndLogin(userAEmail);

    const response = await request(app.getHttpServer())
      .get('/api/v1/wallets/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(response.status).toBe(200);
    expect((response.body as { balance: string }).balance).toBe('0');
  });

  it('lets a user fetch their own wallet by id', async () => {
    const accessToken = await registerAndLogin(userBEmail);
    const meResponse = await request(app.getHttpServer())
      .get('/api/v1/wallets/me')
      .set('Authorization', `Bearer ${accessToken}`);
    const walletId = (meResponse.body as { id: string }).id;

    const response = await request(app.getHttpServer())
      .get(`/api/v1/wallets/${walletId}`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(response.status).toBe(200);
  });

  it('rejects fetching another user wallet with 403', async () => {
    const tokenA = await registerAndLogin(
      `wallets-c-${randomUUID()}@example.com`,
    );
    const tokenB = await registerAndLogin(
      `wallets-d-${randomUUID()}@example.com`,
    );

    const meResponseA = await request(app.getHttpServer())
      .get('/api/v1/wallets/me')
      .set('Authorization', `Bearer ${tokenA}`);
    const walletAId = (meResponseA.body as { id: string }).id;

    const response = await request(app.getHttpServer())
      .get(`/api/v1/wallets/${walletAId}`)
      .set('Authorization', `Bearer ${tokenB}`);

    expect(response.status).toBe(403);
  });

  it('returns 404 for a wallet id that does not exist', async () => {
    const accessToken = await registerAndLogin(
      `wallets-e-${randomUUID()}@example.com`,
    );

    const response = await request(app.getHttpServer())
      .get(`/api/v1/wallets/${randomUUID()}`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(response.status).toBe(404);
  });
});
