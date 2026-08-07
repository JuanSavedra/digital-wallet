import { LoggerService, LogLevel } from '@nestjs/common';
import { RequestContext } from '../context/request-context';
import { redact } from './redact';

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
    // Tudo passa por `redact` antes de virar texto: senha, token, header de
    // autorização e credenciais embutidas em URLs nunca chegam ao stdout,
    // mesmo quando o call site loga um objeto inteiro sem pensar nisso.
    const safeMessage = redact(message);
    // Error nu (`logger.error(exception)`) serializava como "{}" no
    // JSON.stringify direto — `redact` o converte para name/message/stack.
    const line: LogLine = {
      timestamp: new Date().toISOString(),
      level,
      message:
        typeof safeMessage === 'string'
          ? safeMessage
          : JSON.stringify(safeMessage),
      context,
      correlationId: RequestContext.getCorrelationId(),
      trace: trace ? (redact(trace) as string) : undefined,
    };

    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(line)}\n`);
  }
}
