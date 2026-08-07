import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { RequestContext } from '../context/request-context';

export const REQUEST_ID_HEADER = 'x-request-id';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const correlationId =
      (request.headers[REQUEST_ID_HEADER] as string | undefined) ??
      randomUUID();
    request.headers[REQUEST_ID_HEADER] = correlationId;
    response.setHeader(REQUEST_ID_HEADER, correlationId);

    const { method, originalUrl } = request;
    const start = Date.now();

    // `next.handle()` só cria o Observable — nada executa até alguém dar
    // subscribe nele, e é *nesse momento* (não na criação) que o Nest de
    // fato invoca o controller. Por isso tanto a chamada de `next.handle()`
    // quanto o `.subscribe()` do pipeline resultante precisam acontecer
    // dentro de RequestContext.run (que roda de forma síncrona no exato
    // momento em que este Observable é subscrito) — do contrário o
    // controller/services rodariam fora do contexto e o correlationId se
    // perderia antes de chegar em qualquer log deles.
    return new Observable((subscriber) =>
      RequestContext.run({ correlationId }, () =>
        next
          .handle()
          .pipe(
            tap({
              next: () => {
                this.logger.log(
                  `${method} ${originalUrl} ${response.statusCode} +${Date.now() - start}ms`,
                );
              },
              error: (error: Error) => {
                this.logger.error(
                  `${method} ${originalUrl} failed +${Date.now() - start}ms: ${error.message}`,
                );
              },
            }),
          )
          .subscribe(subscriber),
      ),
    );
  }
}
