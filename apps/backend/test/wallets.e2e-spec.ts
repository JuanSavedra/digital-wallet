import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
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
  let jwtService: JwtService;
  let configService: ConfigService;

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
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);
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

  // POST /auth/login tem rate limit de 5/min (proposital). Os testes de
  // lookup abaixo registram vários usuários; assinar o token direto evita
  // estourar esse limite só de preparação de cenário, sem relação nenhuma
  // com o que este bloco testa.
  async function registerAndSignToken(email: string) {
    allEmails.push(email);
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return jwtService.signAsync(
      { sub: user.id, email: user.email },
      { secret: configService.getOrThrow<string>('JWT_ACCESS_SECRET') },
    );
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

  describe('GET /wallets/lookup', () => {
    it('resolves the wallet id for another user by email', async () => {
      const targetEmail = `wallets-f-${randomUUID()}@example.com`;
      const targetToken = await registerAndSignToken(targetEmail);
      const targetMeResponse = await request(app.getHttpServer())
        .get('/api/v1/wallets/me')
        .set('Authorization', `Bearer ${targetToken}`);
      const targetWalletId = (targetMeResponse.body as { id: string }).id;

      const requesterToken = await registerAndSignToken(
        `wallets-g-${randomUUID()}@example.com`,
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/wallets/lookup')
        .query({ email: targetEmail })
        .set('Authorization', `Bearer ${requesterToken}`);

      expect(response.status).toBe(200);
      expect((response.body as { walletId: string }).walletId).toBe(
        targetWalletId,
      );
    });

    it('returns 404 when no user has that email', async () => {
      const requesterToken = await registerAndSignToken(
        `wallets-h-${randomUUID()}@example.com`,
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/wallets/lookup')
        .query({ email: `nobody-${randomUUID()}@example.com` })
        .set('Authorization', `Bearer ${requesterToken}`);

      expect(response.status).toBe(404);
    });

    it('returns 400 for a malformed email', async () => {
      const requesterToken = await registerAndSignToken(
        `wallets-i-${randomUUID()}@example.com`,
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/wallets/lookup')
        .query({ email: 'not-an-email' })
        .set('Authorization', `Bearer ${requesterToken}`);

      expect(response.status).toBe(400);
    });
  });

  describe('POST /wallets/me/deposit', () => {
    it('credits the caller wallet and the new balance is reflected right away (cache invalidated)', async () => {
      const token = await registerAndSignToken(
        `wallets-j-${randomUUID()}@example.com`,
      );

      const first = await request(app.getHttpServer())
        .post('/api/v1/wallets/me/deposit')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 2_000 });
      expect(first.status).toBe(200);
      expect((first.body as { balance: string }).balance).toBe('2000');

      const second = await request(app.getHttpServer())
        .post('/api/v1/wallets/me/deposit')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 500 });
      expect(second.status).toBe(200);
      expect((second.body as { balance: string }).balance).toBe('2500');

      const meResponse = await request(app.getHttpServer())
        .get('/api/v1/wallets/me')
        .set('Authorization', `Bearer ${token}`);
      expect((meResponse.body as { balance: string }).balance).toBe('2500');
    });

    it('rejects a non-positive amount', async () => {
      const token = await registerAndSignToken(
        `wallets-k-${randomUUID()}@example.com`,
      );

      const response = await request(app.getHttpServer())
        .post('/api/v1/wallets/me/deposit')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 0 });

      expect(response.status).toBe(400);
    });

    it('rejects a deposit above the per-request cap', async () => {
      const token = await registerAndSignToken(
        `wallets-l-${randomUUID()}@example.com`,
      );

      const response = await request(app.getHttpServer())
        .post('/api/v1/wallets/me/deposit')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 10_000_01 });

      expect(response.status).toBe(400);
    });
  });
});
