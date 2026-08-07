import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { AdminGuard } from './admin.guard';

function contextFor(user?: { userId: string; email: string }) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function guardWith(adminEmails: string): AdminGuard {
  const configService = {
    get: jest.fn().mockReturnValue(adminEmails),
  } as unknown as ConfigService;
  return new AdminGuard(configService);
}

describe('AdminGuard', () => {
  const admin = { userId: 'u-1', email: 'admin@example.com' };
  const regular = { userId: 'u-2', email: 'alice@example.com' };

  it('allows an email present in ADMIN_EMAILS', () => {
    expect(
      guardWith('admin@example.com,ops@example.com').canActivate(
        contextFor(admin),
      ),
    ).toBe(true);
  });

  it('ignores casing and surrounding whitespace in the configured list', () => {
    expect(
      guardWith(' Admin@Example.com , ops@example.com ').canActivate(
        contextFor(admin),
      ),
    ).toBe(true);
  });

  it('rejects an authenticated user who is not an admin', () => {
    // Este é o buraco que o guard fecha: antes bastava estar logado para
    // chamar POST /admin/dlq/replay e reinjetar eventos de terceiros.
    expect(() =>
      guardWith('admin@example.com').canActivate(contextFor(regular)),
    ).toThrow(ForbiddenException);
  });

  it('rejects everyone when ADMIN_EMAILS is empty (padrão seguro)', () => {
    expect(() => guardWith('').canActivate(contextFor(admin))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects an unauthenticated request', () => {
    expect(() =>
      guardWith('admin@example.com').canActivate(contextFor(undefined)),
    ).toThrow(UnauthorizedException);
  });
});
