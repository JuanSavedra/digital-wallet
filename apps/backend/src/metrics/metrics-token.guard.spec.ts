import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { MetricsTokenGuard } from './metrics-token.guard';

function contextFor(authorization?: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: authorization ? { authorization } : {} }),
    }),
  } as unknown as ExecutionContext;
}

function guardWith(token: string): MetricsTokenGuard {
  const configService = {
    get: jest.fn().mockReturnValue(token),
  } as unknown as ConfigService;
  return new MetricsTokenGuard(configService);
}

describe('MetricsTokenGuard', () => {
  it('stays open when METRICS_TOKEN is not configured', () => {
    // Compatível com o docker-compose atual, onde o scraper vive na rede
    // interna e não manda header nenhum.
    expect(guardWith('').canActivate(contextFor())).toBe(true);
  });

  it('accepts the configured bearer token', () => {
    expect(guardWith('s3cr3t').canActivate(contextFor('Bearer s3cr3t'))).toBe(
      true,
    );
  });

  it('rejects a wrong token', () => {
    expect(() =>
      guardWith('s3cr3t').canActivate(contextFor('Bearer errado')),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a request with no Authorization header once a token is required', () => {
    expect(() => guardWith('s3cr3t').canActivate(contextFor())).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token of a different length without leaking through timingSafeEqual', () => {
    // timingSafeEqual lança se os buffers tiverem tamanhos diferentes — o
    // guard precisa tratar isso antes, senão vira 500 em vez de 401.
    expect(() =>
      guardWith('s3cr3t').canActivate(contextFor('Bearer s')),
    ).toThrow(UnauthorizedException);
  });
});
