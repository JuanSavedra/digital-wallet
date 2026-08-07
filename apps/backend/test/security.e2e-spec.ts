import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { REFRESH_COOKIE_NAME } from '../src/auth/refresh-cookie';
import { PrismaService } from '../src/prisma/prisma.service';
import { configureApp } from '../src/setup-app';
import { deleteLedgerEntries } from './utils/ledger-cleanup';

/**
 * Escopo 13 — validações de segurança ponta a ponta, contra Postgres/Redis
 * reais. Cada teste aqui corresponde a uma falha concreta que existia antes:
 * o refresh token voltando no corpo, o ledger sendo mutável, `/admin/dlq`
 * aberto a qualquer usuário logado, e a paginação sem teto.
 */
describe('Segurança (e2e, infra real)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const password = 'senha-forte-123';
  const emails: string[] = [];

  const url = (path: string) => `/api/v1${path}`;

  async function registerAndLogin(rawEmail: string) {
    const email = rawEmail.toLowerCase();
    emails.push(email);
    await request(app.getHttpServer())
      .post(url('/auth/register'))
      .send({ email: rawEmail, password });

    const login = await request(app.getHttpServer())
      .post(url('/auth/login'))
      .send({ email: rawEmail, password });

    return {
      email,
      accessToken: (login.body as { accessToken: string }).accessToken,
      cookies: login.headers['set-cookie'] as unknown as string[],
    };
  }

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
    try {
      const users = await prisma.user.findMany({
        where: { email: { in: emails } },
        select: { id: true },
      });
      const userIds = users.map((user) => user.id);
      const wallets = await prisma.wallet.findMany({
        where: { userId: { in: userIds } },
        select: { id: true },
      });
      const walletIds = wallets.map((wallet) => wallet.id);

      const transactions = await prisma.transaction.findMany({
        where: { originWalletId: { in: walletIds } },
        select: { id: true },
      });
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: { in: transactions.map((tx) => tx.id) } },
      });
      await deleteLedgerEntries(prisma, { walletId: { in: walletIds } });
      await prisma.transaction.deleteMany({
        where: { originWalletId: { in: walletIds } },
      });
      await prisma.walletDeposit.deleteMany({
        where: { walletId: { in: walletIds } },
      });
      await prisma.wallet.deleteMany({ where: { id: { in: walletIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await app.close();
    }
  });

  describe('armazenamento do refresh token', () => {
    it('devolve o refresh token só no cookie httpOnly, nunca no corpo', async () => {
      const email = `sec-cookie-${randomUUID()}@example.com`;
      emails.push(email);
      await request(app.getHttpServer())
        .post(url('/auth/register'))
        .send({ email, password });

      const response = await request(app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email, password });

      expect(response.status).toBe(200);
      // O corpo carrega apenas o access token, de vida curta.
      expect(response.body).toEqual({ accessToken: expect.any(String) });
      expect(JSON.stringify(response.body)).not.toContain('refreshToken');

      const cookies = response.headers['set-cookie'] as unknown as string[];
      const refreshCookie = cookies.find((cookie) =>
        cookie.startsWith(`${REFRESH_COOKIE_NAME}=`),
      );

      expect(refreshCookie).toBeDefined();
      // HttpOnly é o que impede um XSS de ler a credencial de longa duração.
      expect(refreshCookie).toContain('HttpOnly');
      // SameSite=Strict é a defesa de CSRF do POST /auth/refresh.
      expect(refreshCookie).toContain('SameSite=Strict');
      expect(refreshCookie).toContain('Path=/api/v1/auth');
    });

    it('renova a sessão usando só o cookie, sem corpo nenhum', async () => {
      const email = `sec-refresh-${randomUUID()}@example.com`;
      const session = await registerAndLogin(email);

      const refreshed = await request(app.getHttpServer())
        .post(url('/auth/refresh'))
        .set('Cookie', session.cookies)
        .send({});

      expect(refreshed.status).toBe(200);
      expect(refreshed.body).toEqual({ accessToken: expect.any(String) });
    });

    it('rejeita o refresh sem cookie e sem corpo', async () => {
      const response = await request(app.getHttpServer())
        .post(url('/auth/refresh'))
        .send({});

      expect(response.status).toBe(401);
    });

    it('limpa o cookie no logout e invalida o token rotacionado', async () => {
      const email = `sec-logout-${randomUUID()}@example.com`;
      const session = await registerAndLogin(email);

      const logout = await request(app.getHttpServer())
        .post(url('/auth/logout'))
        .set('Cookie', session.cookies)
        .send({});
      expect(logout.status).toBe(204);

      const cleared = (
        logout.headers['set-cookie'] as unknown as string[]
      ).find((cookie) => cookie.startsWith(`${REFRESH_COOKIE_NAME}=`));
      expect(cleared).toContain('HttpOnly');

      const afterLogout = await request(app.getHttpServer())
        .post(url('/auth/refresh'))
        .set('Cookie', session.cookies)
        .send({});
      expect(afterLogout.status).toBe(401);
    });
  });

  describe('normalização de e-mail', () => {
    it('trata variações de caixa como a mesma conta, no cadastro e no lookup', async () => {
      const local = `sec-case-${randomUUID()}`;
      const session = await registerAndLogin(`${local}@example.com`);

      // Sem normalização isto criaria uma SEGUNDA conta, homógrafa, capaz de
      // receber transferências destinadas à primeira.
      const duplicate = await request(app.getHttpServer())
        .post(url('/auth/register'))
        .send({ email: `${local.toUpperCase()}@EXAMPLE.COM`, password });
      expect(duplicate.status).toBe(409);

      const lookup = await request(app.getHttpServer())
        .get(url('/wallets/lookup'))
        .query({ email: `${local.toUpperCase()}@Example.com` })
        .set('Authorization', `Bearer ${session.accessToken}`);
      expect(lookup.status).toBe(200);
      expect((lookup.body as { walletId: string }).walletId).toEqual(
        expect.any(String),
      );
    });

    it('permite login com o e-mail em outra caixa', async () => {
      const local = `sec-login-case-${randomUUID()}`;
      await registerAndLogin(`${local}@example.com`);

      const response = await request(app.getHttpServer())
        .post(url('/auth/login'))
        .send({ email: `${local.toUpperCase()}@EXAMPLE.COM`, password });

      expect(response.status).toBe(200);
    });
  });

  describe('validação de payload', () => {
    it('rejeita uma senha maior que o limite do bcrypt (72 bytes)', async () => {
      const response = await request(app.getHttpServer())
        .post(url('/auth/register'))
        .send({
          email: `sec-longpass-${randomUUID()}@example.com`,
          password: 'a'.repeat(200),
        });

      expect(response.status).toBe(400);
    });

    it('rejeita um id de rota que não é UUID em vez de consultar o banco', async () => {
      const session = await registerAndLogin(
        `sec-uuid-${randomUUID()}@example.com`,
      );

      const response = await request(app.getHttpServer())
        .get(url('/transactions/not-a-uuid'))
        .set('Authorization', `Bearer ${session.accessToken}`);

      expect(response.status).toBe(400);
    });

    it('rejeita uma página de extrato absurda, que viraria um take gigante no Postgres', async () => {
      const session = await registerAndLogin(
        `sec-page-${randomUUID()}@example.com`,
      );

      const response = await request(app.getHttpServer())
        .get(url('/wallets/me/statement'))
        .query({ page: 10_000_000 })
        .set('Authorization', `Bearer ${session.accessToken}`);

      expect(response.status).toBe(400);
    });

    it('rejeita um valor de transferência acima do teto, em vez de estourar o BIGINT com 500', async () => {
      const session = await registerAndLogin(
        `sec-amount-${randomUUID()}@example.com`,
      );

      const response = await request(app.getHttpServer())
        .post(url('/transactions/transfer'))
        .set('Authorization', `Bearer ${session.accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ destinationWalletId: randomUUID(), amount: 1e21 });

      expect(response.status).toBe(400);
    });

    it('rejeita campos desconhecidos no corpo (whitelist do ValidationPipe)', async () => {
      const response = await request(app.getHttpServer())
        .post(url('/auth/register'))
        .send({
          email: `sec-extra-${randomUUID()}@example.com`,
          password,
          isAdmin: true,
        });

      expect(response.status).toBe(400);
    });
  });

  describe('autorização das rotas administrativas', () => {
    it('nega /admin/dlq a um usuário autenticado que não é admin', async () => {
      const session = await registerAndLogin(
        `sec-admin-${randomUUID()}@example.com`,
      );

      // Antes do Escopo 13 isto respondia 200 — qualquer conta cadastrada
      // podia inspecionar e reprocessar a DLQ.
      const status = await request(app.getHttpServer())
        .get(url('/admin/dlq'))
        .set('Authorization', `Bearer ${session.accessToken}`);
      expect(status.status).toBe(403);

      const replay = await request(app.getHttpServer())
        .post(url('/admin/dlq/replay'))
        .set('Authorization', `Bearer ${session.accessToken}`);
      expect(replay.status).toBe(403);
    });

    it('continua exigindo autenticação antes da autorização', async () => {
      const response = await request(app.getHttpServer()).get(
        url('/admin/dlq'),
      );

      expect(response.status).toBe(401);
    });
  });

  describe('rate limiting', () => {
    // As demais suítes rodam com o rate limit desligado (ver setup-e2e.ts),
    // senão falhariam por 429 ao registrar dezenas de usuários. Aqui ele é
    // religado de propósito — `skipIf` é avaliado a cada requisição.
    beforeEach(() => {
      delete process.env.RATE_LIMIT_DISABLED;
    });

    afterEach(() => {
      process.env.RATE_LIMIT_DISABLED = 'true';
    });

    it('devolve 429 após estourar o limite de tentativas de login', async () => {
      const email = `sec-throttle-${randomUUID()}@example.com`;
      emails.push(email);

      const statuses: number[] = [];
      // Limite configurado: 5 por minuto. A sexta tentativa já é barrada,
      // que é o que transforma força bruta de senha em algo inviável.
      for (let attempt = 0; attempt < 7; attempt++) {
        const response = await request(app.getHttpServer())
          .post(url('/auth/login'))
          .send({ email, password: 'senha-errada-123' });
        statuses.push(response.status);
      }

      expect(statuses).toContain(429);
      expect(statuses.filter((status) => status === 401).length).toBeLessThan(
        7,
      );
    });
  });

  describe('cabeçalhos de segurança', () => {
    it('responde com os cabeçalhos do helmet', async () => {
      const response = await request(app.getHttpServer()).get(
        url('/wallets/me'),
      );

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
      // helmet remove o header que denuncia o framework.
      expect(response.headers['x-powered-by']).toBeUndefined();
    });
  });
});
