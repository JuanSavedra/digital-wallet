import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextStore {
  correlationId: string;
}

/**
 * Carrega o correlation id através de toda a cadeia assíncrona de uma
 * requisição (ou de um evento consumido do RabbitMQ) sem precisar passá-lo
 * explicitamente por parâmetro em cada serviço — é isso que permite o
 * JsonLoggerService anexar `correlationId` a qualquer log emitido durante
 * esse fluxo, incluindo dentro do outbox relay e do consumer.
 */
export class RequestContext {
  private static readonly storage =
    new AsyncLocalStorage<RequestContextStore>();

  static run<T>(store: RequestContextStore, callback: () => T): T {
    return this.storage.run(store, callback);
  }

  static getCorrelationId(): string | undefined {
    return this.storage.getStore()?.correlationId;
  }
}
