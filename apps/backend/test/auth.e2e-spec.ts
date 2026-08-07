import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { REFRESH_COOKIE_NAME } from '../src/auth/refresh-cookie';
import { PrismaService } from '../src/prisma/prisma.service';
import { configureApp } from '../src/setup-app';

/**
 * Requer Postgres e Redis reais rodando (ex.: `make up`), apontados pelo
 * `.env` da raiz do repo — não é hermético como test/app.e2e-spec.ts.
 * Exercita o fluxo completo de autenticação através da API HTTP real.
 */
describe('Auth flow (e2e, infra real)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const email = `e2e-${randomUUID()}@example.com`;
  const password = 'senha-forte-123';

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
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.wallet.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
    await app.close();
  });

  it('registers a new user', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password });

    const body = response.body as { id: string; email: string };
    expect(response.status).toBe(201);
    expect(body).toEqual(
      expect.objectContaining({ email, id: expect.any(String) }),
    );
  });

  it('rejects registering the same email twice', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password });

    expect(response.status).toBe(409);
  });

  it('rejects login with the wrong password', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'wrong-password' });

    expect(response.status).toBe(401);
  });

  it('logs in returning the access token in the body and the refresh token only in a httpOnly cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accessToken: expect.any(String) });

    const refreshCookie = (
      response.headers['set-cookie'] as unknown as string[]
    ).find((cookie) => cookie.startsWith(`${REFRESH_COOKIE_NAME}=`));
    expect(refreshCookie).toContain('HttpOnly');
  });

  it('rejects /users/me without a token', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/users/me');

    expect(response.status).toBe(401);
  });

  it('runs the full session lifecycle: protected route, refresh rotation, logout', async () => {
    const loginResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password });
    const { accessToken } = loginResponse.body as { accessToken: string };
    const cookies = loginResponse.headers['set-cookie'] as unknown as string[];

    const meResponse = await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(meResponse.status).toBe(200);
    expect((meResponse.body as { email: string }).email).toBe(email);

    // O refresh vai só com o cookie — o corpo não carrega mais o token.
    const refreshResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookies)
      .send({});
    expect(refreshResponse.status).toBe(200);
    const rotatedCookies = refreshResponse.headers[
      'set-cookie'
    ] as unknown as string[];
    expect(rotatedCookies[0]).not.toBe(cookies[0]);

    // Rotação: o cookie antigo já não vale mais.
    const reusedOldTokenResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookies)
      .send({});
    expect(reusedOldTokenResponse.status).toBe(401);

    const logoutResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Cookie', rotatedCookies)
      .send({});
    expect(logoutResponse.status).toBe(204);

    const refreshAfterLogoutResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', rotatedCookies)
      .send({});
    expect(refreshAfterLogoutResponse.status).toBe(401);
  });
});
