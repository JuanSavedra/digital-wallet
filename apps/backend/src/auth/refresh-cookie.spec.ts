import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import {
  REFRESH_COOKIE_NAME,
  clearRefreshCookie,
  readRefreshToken,
  setRefreshCookie,
} from './refresh-cookie';

function configWith(values: Record<string, unknown>): ConfigService {
  return {
    get: jest.fn((key: string, fallback?: unknown) =>
      key in values ? values[key] : fallback,
    ),
  } as unknown as ConfigService;
}

describe('refresh cookie', () => {
  let response: { cookie: jest.Mock; clearCookie: jest.Mock };

  beforeEach(() => {
    response = { cookie: jest.fn(), clearCookie: jest.fn() };
  });

  it('sets the cookie httpOnly, SameSite=Strict and scoped to the auth routes', () => {
    setRefreshCookie(
      response as unknown as Response,
      configWith({ NODE_ENV: 'development' }),
      'refresh-token',
      1000,
    );

    expect(response.cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE_NAME,
      'refresh-token',
      expect.objectContaining({
        // httpOnly é o ponto inteiro da mudança: sem ele um XSS lê o token.
        httpOnly: true,
        // SameSite=Strict é a defesa de CSRF do POST /auth/refresh.
        sameSite: 'strict',
        path: '/api/v1/auth',
        maxAge: 1000,
      }),
    );
  });

  it('marks the cookie Secure in production even without an explicit flag', () => {
    setRefreshCookie(
      response as unknown as Response,
      configWith({ NODE_ENV: 'production' }),
      'refresh-token',
      1000,
    );

    expect(response.cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE_NAME,
      'refresh-token',
      expect.objectContaining({ secure: true }),
    );
  });

  it('forces Secure when SameSite=None, which browsers reject otherwise', () => {
    setRefreshCookie(
      response as unknown as Response,
      configWith({
        NODE_ENV: 'development',
        REFRESH_COOKIE_SAMESITE: 'none',
      }),
      'refresh-token',
      1000,
    );

    expect(response.cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE_NAME,
      'refresh-token',
      expect.objectContaining({ sameSite: 'none', secure: true }),
    );
  });

  it('clears the cookie with the same attributes it was set with', () => {
    // Atributos diferentes = o navegador trata como outro cookie e o
    // original sobrevive ao logout.
    clearRefreshCookie(
      response as unknown as Response,
      configWith({ NODE_ENV: 'development' }),
    );

    expect(response.clearCookie).toHaveBeenCalledWith(
      REFRESH_COOKIE_NAME,
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'strict',
        path: '/api/v1/auth',
      }),
    );
  });

  describe('readRefreshToken', () => {
    it('prefers the cookie over the request body', () => {
      const request = {
        cookies: { [REFRESH_COOKIE_NAME]: 'from-cookie' },
      } as unknown as Request;

      expect(readRefreshToken(request, 'from-body')).toBe('from-cookie');
    });

    it('falls back to the body for clients without a cookie jar (curl, integrações)', () => {
      const request = { cookies: {} } as unknown as Request;

      expect(readRefreshToken(request, 'from-body')).toBe('from-body');
    });

    it('returns undefined when neither is present', () => {
      const request = {} as unknown as Request;

      expect(readRefreshToken(request, undefined)).toBeUndefined();
    });
  });
});
