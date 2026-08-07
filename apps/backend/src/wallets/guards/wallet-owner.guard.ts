import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { RequestUser } from '../../auth/decorators/current-user.decorator';
import { WalletsService } from '../wallets.service';

/**
 * Garante que o usuário autenticado só acesse a carteira identificada pelo
 * parâmetro de rota `:id` se ela for dele. Requer JwtAuthGuard antes (para
 * popular request.user) e um param `id` na rota.
 */
@Injectable()
export class WalletOwnerGuard implements CanActivate {
  constructor(private readonly walletsService: WalletsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: RequestUser }>();

    if (!request.user) {
      throw new UnauthorizedException();
    }

    const walletId = String(request.params.id);
    await this.walletsService.assertOwnership(walletId, request.user.userId);
    return true;
  }
}
