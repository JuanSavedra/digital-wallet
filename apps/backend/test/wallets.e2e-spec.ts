import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import type { AuthTokens } from '../src/auth/interfaces/token-payload.interface';
import {
  AbacatePayCheckout,
  AbacatePayService,
} from '../src/payments/abacatepay.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { configureApp } from '../src/setup-app';
import { poll } from './utils/poll';

/**
 * Requer Postgres e Redis reais (`make up`). Cobre o auto-provisionamento
 * de carteira no registro e o guard de propriedade (WalletOwnerGuard),
 * fechando o item pendente do Escopo 3.
 */
/**
 * Dublê de AbacatePayService: nunca bate na API real. `createPixCheckout`
 * inicia como PENDING; os testes usam `setStatus` para simular o que a
 * AbacatePay reportaria depois do usuário "pagar" no checkout hospedado.
 */
class FakeAbacatePayService {
  private readonly statuses = new Map<string, AbacatePayCheckout['status']>();

  createProduct(): Promise<{ id: string }> {
    return Promise.resolve({ id: `prod_${randomUUID()}` });
  }

  createPixCheckout(): Promise<AbacatePayCheckout> {
    const id = `checkout_${randomUUID()}`;
    this.statuses.set(id, 'PENDING');
    return Promise.resolve({
      id,
      url: `https://fake.abacatepay.test/checkouts/${id}`,
      status: 'PENDING',
    });
  }

  findCheckoutById(id: string): Promise<AbacatePayCheckout | null> {
    const status = this.statuses.get(id);
    if (!status) return Promise.resolve(null);
    return Promise.resolve({
      id,
      url: `https://fake.abacatepay.test/checkouts/${id}`,
      status,
    });
  }

  setStatus(id: string, status: AbacatePayCheckout['status']): void {
    this.statuses.set(id, status);
  }
}

function checkoutIdFromUrl(checkoutUrl: string): string {
  return checkoutUrl.split('/').pop()!;
}

describe('Wallets ownership (e2e, infra real)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let configService: ConfigService;
  const fakeAbacatePayService = new FakeAbacatePayService();

  const userAEmail = `wallets-a-${randomUUID()}@example.com`;
  const userBEmail = `wallets-b-${randomUUID()}@example.com`;
  const password = 'senha-forte-123';
  const allEmails = [userAEmail, userBEmail];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AbacatePayService)
      .useValue(fakeAbacatePayService)
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    jwtService = app.get(JwtService);
    configService = app.get(ConfigService);
  });

  afterAll(async () => {
    // Precisa apagar em ordem (deposits -> wallets -> users) por causa das
    // FKs — e sempre fechar o app no finally: se a limpeza falhar antes de
    // `app.close()`, as conexões do Redis/RabbitMQ ficam abertas e o Jest
    // trava esperando por elas indefinidamente em vez de só reportar o erro.
    try {
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
      await prisma.walletDeposit.deleteMany({
        where: { walletId: { in: walletIds } },
      });
      await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await app.close();
    }
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

  describe('POST /wallets/me/deposits (AbacatePay, dublê em dev)', () => {
    it('creates a PENDING deposit with a checkout url', async () => {
      const token = await registerAndSignToken(
        `wallets-j-${randomUUID()}@example.com`,
      );

      const response = await request(app.getHttpServer())
        .post('/api/v1/wallets/me/deposits')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 2_000 });

      expect(response.status).toBe(201);
      const body = response.body as {
        id: string;
        amount: string;
        status: string;
        checkoutUrl: string;
      };
      expect(body.status).toBe('PENDING');
      expect(body.amount).toBe('2000');
      expect(body.checkoutUrl).toContain('fake.abacatepay.test');
    });

    it('rejects a non-positive amount', async () => {
      const token = await registerAndSignToken(
        `wallets-k-${randomUUID()}@example.com`,
      );

      const response = await request(app.getHttpServer())
        .post('/api/v1/wallets/me/deposits')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 0 });

      expect(response.status).toBe(400);
    });

    it('rejects a deposit above the per-request cap', async () => {
      const token = await registerAndSignToken(
        `wallets-l-${randomUUID()}@example.com`,
      );

      const response = await request(app.getHttpServer())
        .post('/api/v1/wallets/me/deposits')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 10_000_01 });

      expect(response.status).toBe(400);
    });

    it('credits the wallet once the provider reports PAID, and the cache reflects it right away', async () => {
      const token = await registerAndSignToken(
        `wallets-m-${randomUUID()}@example.com`,
      );

      const created = await request(app.getHttpServer())
        .post('/api/v1/wallets/me/deposits')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 3_000 });
      const deposit = created.body as { id: string; checkoutUrl: string };

      const stillPending = await request(app.getHttpServer())
        .get(`/api/v1/wallets/me/deposits/${deposit.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect((stillPending.body as { status: string }).status).toBe('PENDING');

      fakeAbacatePayService.setStatus(
        checkoutIdFromUrl(deposit.checkoutUrl),
        'PAID',
      );

      const confirmed = await poll(
        () =>
          request(app.getHttpServer())
            .get(`/api/v1/wallets/me/deposits/${deposit.id}`)
            .set('Authorization', `Bearer ${token}`),
        (res) => (res.body as { status: string }).status === 'PAID',
      );
      expect((confirmed.body as { status: string }).status).toBe('PAID');

      const meResponse = await request(app.getHttpServer())
        .get('/api/v1/wallets/me')
        .set('Authorization', `Bearer ${token}`);
      expect((meResponse.body as { balance: string }).balance).toBe('3000');
    });

    it('never double-credits when the same PAID deposit is polled concurrently', async () => {
      const token = await registerAndSignToken(
        `wallets-n-${randomUUID()}@example.com`,
      );

      const created = await request(app.getHttpServer())
        .post('/api/v1/wallets/me/deposits')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 1_500 });
      const deposit = created.body as { id: string; checkoutUrl: string };

      fakeAbacatePayService.setStatus(
        checkoutIdFromUrl(deposit.checkoutUrl),
        'PAID',
      );

      const pollDeposit = () =>
        request(app.getHttpServer())
          .get(`/api/v1/wallets/me/deposits/${deposit.id}`)
          .set('Authorization', `Bearer ${token}`);

      const results = await Promise.all([
        pollDeposit(),
        pollDeposit(),
        pollDeposit(),
      ]);
      for (const result of results) {
        expect((result.body as { status: string }).status).toBe('PAID');
      }

      const meResponse = await request(app.getHttpServer())
        .get('/api/v1/wallets/me')
        .set('Authorization', `Bearer ${token}`);
      expect((meResponse.body as { balance: string }).balance).toBe('1500');
    });

    it('marks the deposit CANCELLED when the provider reports a terminal non-paid status, without crediting', async () => {
      const token = await registerAndSignToken(
        `wallets-o-${randomUUID()}@example.com`,
      );

      const created = await request(app.getHttpServer())
        .post('/api/v1/wallets/me/deposits')
        .set('Authorization', `Bearer ${token}`)
        .send({ amount: 900 });
      const deposit = created.body as { id: string; checkoutUrl: string };

      fakeAbacatePayService.setStatus(
        checkoutIdFromUrl(deposit.checkoutUrl),
        'CANCELLED',
      );

      const response = await request(app.getHttpServer())
        .get(`/api/v1/wallets/me/deposits/${deposit.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect((response.body as { status: string }).status).toBe('CANCELLED');

      const meResponse = await request(app.getHttpServer())
        .get('/api/v1/wallets/me')
        .set('Authorization', `Bearer ${token}`);
      expect((meResponse.body as { balance: string }).balance).toBe('0');
    });

    it('rejects fetching a deposit that belongs to another user with 403', async () => {
      const ownerToken = await registerAndSignToken(
        `wallets-p-${randomUUID()}@example.com`,
      );
      const intruderToken = await registerAndSignToken(
        `wallets-q-${randomUUID()}@example.com`,
      );

      const created = await request(app.getHttpServer())
        .post('/api/v1/wallets/me/deposits')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ amount: 700 });
      const deposit = created.body as { id: string };

      const response = await request(app.getHttpServer())
        .get(`/api/v1/wallets/me/deposits/${deposit.id}`)
        .set('Authorization', `Bearer ${intruderToken}`);

      expect(response.status).toBe(403);
    });
  });
});
