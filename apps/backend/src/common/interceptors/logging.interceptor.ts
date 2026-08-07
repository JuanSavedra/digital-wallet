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

export const REQUEST_ID_HEADER = 'x-request-id';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    const requestId =
      (request.headers[REQUEST_ID_HEADER] as string | undefined) ??
      randomUUID();
    request.headers[REQUEST_ID_HEADER] = requestId;
    response.setHeader(REQUEST_ID_HEADER, requestId);

    const { method, originalUrl } = request;
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.log(
            `[${requestId}] ${method} ${originalUrl} ${response.statusCode} +${Date.now() - start}ms`,
          );
        },
        error: (error: Error) => {
          this.logger.error(
            `[${requestId}] ${method} ${originalUrl} failed +${Date.now() - start}ms: ${error.message}`,
          );
        },
      }),
    );
  }
}
