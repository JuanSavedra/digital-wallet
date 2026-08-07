import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse = isHttpException
      ? exception.getResponse()
      : 'Internal server error';

    const rawMessage =
      typeof exceptionResponse === 'string'
        ? exceptionResponse
        : ((exceptionResponse as { message?: string | string[] }).message ??
          exceptionResponse);

    // Erro não previsto: a mensagem original pode carregar detalhe de
    // infraestrutura (SQL, nome de coluna, host do banco, trecho do
    // payload). Vai inteira para o log, mas o cliente só recebe o genérico.
    const message = isHttpException ? rawMessage : 'Internal server error';

    if (!isHttpException) {
      this.logger.error(
        exception instanceof Error ? exception : String(exception),
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(status).json({
      statusCode: status,
      path: request.url,
      timestamp: new Date().toISOString(),
      requestId: request.headers['x-request-id'],
      message,
    });
  }
}
