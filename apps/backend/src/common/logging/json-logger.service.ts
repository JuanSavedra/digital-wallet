import { LoggerService, LogLevel } from '@nestjs/common';
import { RequestContext } from '../context/request-context';

interface LogLine {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: string;
  correlationId?: string;
  trace?: string;
}

/**
 * Logger em JSON (uma linha por evento), para ser agregável por ferramentas
 * de observabilidade (ex. Loki/ELK) em vez do formato colorido padrão do
 * Nest, que é só para leitura humana no terminal. Anexa o correlationId do
 * AsyncLocalStorage automaticamente, sem que cada call site precise passá-lo.
 */
export class JsonLoggerService implements LoggerService {
  log(message: unknown, context?: string): void {
    this.write('log', message, context);
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.write('error', message, context, trace);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, context);
  }

  private write(
    level: LogLevel,
    message: unknown,
    context?: string,
    trace?: string,
  ): void {
    const line: LogLine = {
      timestamp: new Date().toISOString(),
      level,
      message: typeof message === 'string' ? message : JSON.stringify(message),
      context,
      correlationId: RequestContext.getCorrelationId(),
      trace,
    };

    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(line)}\n`);
  }
}
