import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * `GET /api/metrics` expõe latências, contagem de erros, tamanho da DLQ e as
 * métricas default do processo (versão do Node, uso de memória, event loop)
 * — reconhecimento gratuito para quem estiver mapeando a aplicação, e um
 * canal lateral sobre o volume de transferências.
 *
 * Quando `METRICS_TOKEN` está configurado, exige `Authorization: Bearer
 * <token>`. Quando está vazio, o endpoint continua aberto — o scraper do
 * Prometheus costuma viver na rede interna, e forçar o token quebraria o
 * setup atual do docker-compose sem aviso.
 */
@Injectable()
export class MetricsTokenGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.configService.get<string>('METRICS_TOKEN', '');
    if (!expected) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!this.matches(provided, expected)) {
      throw new UnauthorizedException();
    }
    return true;
  }

  /** Comparação em tempo constante: um `===` vazaria o token caractere a
   * caractere para quem medisse o tempo de resposta. */
  private matches(provided: string, expected: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  }
}
