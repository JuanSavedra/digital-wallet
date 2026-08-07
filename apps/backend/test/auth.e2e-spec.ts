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
    await prisma.user.deleteMany({ where: { email } });
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

  it('logs in and returns an access/refresh token pair', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password });

    const body = response.body as AuthTokens;
    expect(response.status).toBe(200);
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
  });

  it('rejects /users/me without a token', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/users/me');

    expect(response.status).toBe(401);
  });

  it('runs the full session lifecycle: protected route, refresh rotation, logout', async () => {
    const loginResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password });
    const { accessToken, refreshToken } = loginResponse.body as AuthTokens;

    const meResponse = await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(meResponse.status).toBe(200);
    expect((meResponse.body as { email: string }).email).toBe(email);

    const refreshResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
    expect(refreshResponse.status).toBe(200);
    const newRefreshToken = (refreshResponse.body as AuthTokens).refreshToken;
    expect(newRefreshToken).not.toBe(refreshToken);

    const reusedOldTokenResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken });
    expect(reusedOldTokenResponse.status).toBe(401);

    const logoutResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken: newRefreshToken });
    expect(logoutResponse.status).toBe(204);

    const refreshAfterLogoutResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: newRefreshToken });
    expect(refreshAfterLogoutResponse.status).toBe(401);
  });
});
