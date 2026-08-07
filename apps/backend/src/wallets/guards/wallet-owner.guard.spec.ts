import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { WalletsService } from '../wallets.service';
import { WalletOwnerGuard } from './wallet-owner.guard';

function createContext(
  params: Record<string, string>,
  user?: { userId: string },
) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ params, user }),
    }),
  } as unknown as ExecutionContext;
}

describe('WalletOwnerGuard', () => {
  let walletsService: jest.Mocked<WalletsService>;
  let guard: WalletOwnerGuard;

  beforeEach(() => {
    walletsService = {
      assertOwnership: jest.fn(),
    } as unknown as jest.Mocked<WalletsService>;
    guard = new WalletOwnerGuard(walletsService);
  });

  it('allows access when the wallet belongs to the requesting user', async () => {
    walletsService.assertOwnership.mockResolvedValue({} as never);
    const context = createContext({ id: 'wallet-1' }, { userId: 'user-1' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(walletsService.assertOwnership).toHaveBeenCalledWith(
      'wallet-1',
      'user-1',
    );
  });

  it('propagates the ForbiddenException when the wallet belongs to someone else', async () => {
    walletsService.assertOwnership.mockRejectedValue(new ForbiddenException());
    const context = createContext({ id: 'wallet-1' }, { userId: 'user-2' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws UnauthorizedException when there is no authenticated user', async () => {
    const context = createContext({ id: 'wallet-1' }, undefined);

    await expect(guard.canActivate(context)).rejects.toThrow();
    expect(walletsService.assertOwnership).not.toHaveBeenCalled();
  });
});
