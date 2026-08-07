import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { RequestUser } from '../decorators/current-user.decorator';

/**
 * Autorização das rotas administrativas por lista de e-mails (`ADMIN_EMAILS`,
 * separados por vírgula). Não existe conceito de "role" no modelo de dados,
 * e inventar um só para isso seria uma mudança de escopo maior — a lista em
 * configuração resolve o problema imediato.
 *
 * O problema era concreto: `/admin/dlq` estava atrás apenas do
 * `JwtAuthGuard`, então **qualquer usuário cadastrado** podia ler a fila de
 * mensagens mortas e, pior, chamar `POST /admin/dlq/replay` para reinjetar
 * eventos de transação de outras pessoas na exchange principal.
 *
 * Padrão seguro: sem `ADMIN_EMAILS` configurado, ninguém entra.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: RequestUser }>();

    if (!request.user) {
      throw new UnauthorizedException();
    }

    const admins = this.configService
      .get<string>('ADMIN_EMAILS', '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);

    if (!admins.includes(request.user.email.toLowerCase())) {
      throw new ForbiddenException('Acesso restrito a administradores');
    }

    return true;
  }
}
