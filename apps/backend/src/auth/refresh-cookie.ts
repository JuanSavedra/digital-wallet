import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';

export const REFRESH_COOKIE_NAME = 'dw_refresh';

/**
 * Caminho restrito de propósito: o cookie só é enviado para as rotas de
 * autenticação. Nenhuma outra rota da API precisa dele, então limitar o
 * escopo reduz a superfície caso algum endpoint passe a refletir headers.
 */
const REFRESH_COOKIE_PATH = '/api/v1/auth';

function baseOptions(configService: ConfigService): CookieOptions {
  const sameSite = configService.get<'strict' | 'lax' | 'none'>(
    'REFRESH_COOKIE_SAMESITE',
    'strict',
  );

  return {
    // A defesa central: JavaScript da página não consegue ler o cookie, então
    // um XSS não exfiltra a credencial de longa duração da sessão.
    httpOnly: true,
    // `SameSite=Strict` é o que protege contra CSRF neste desenho — o
    // navegador não anexa o cookie em requisições originadas de outro site,
    // então um POST forjado para /auth/refresh chega sem credencial nenhuma.
    sameSite,
    // `SameSite=None` só é aceito pelos navegadores junto de `Secure`.
    secure:
      sameSite === 'none' ||
      configService.get<boolean>('REFRESH_COOKIE_SECURE', false) ||
      configService.get<string>('NODE_ENV') === 'production',
    path: REFRESH_COOKIE_PATH,
  };
}

export function setRefreshCookie(
  response: Response,
  configService: ConfigService,
  refreshToken: string,
  maxAgeMs: number,
): void {
  response.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    ...baseOptions(configService),
    maxAge: maxAgeMs,
  });
}

export function clearRefreshCookie(
  response: Response,
  configService: ConfigService,
): void {
  response.clearCookie(REFRESH_COOKIE_NAME, baseOptions(configService));
}

/**
 * O cookie tem precedência sobre o corpo: é ele que o frontend usa. O campo
 * no corpo continua aceito para clientes sem cookie jar (curl, integrações,
 * testes de API).
 */
export function readRefreshToken(
  request: Request,
  bodyToken?: string,
): string | undefined {
  const cookies = request.cookies as Record<string, string> | undefined;
  return cookies?.[REFRESH_COOKIE_NAME] ?? bodyToken;
}
