export const WALLET_EVENTS_EXCHANGE = 'wallet.events';
export const TRANSACTION_COMPLETED_ROUTING_KEY = 'transaction.completed';

export const TRANSACTIONS_PROCESS_QUEUE = 'transactions.process';
export const TRANSACTIONS_RETRY_QUEUE = 'transactions.process.retry';
export const TRANSACTIONS_DLQ_QUEUE = 'transactions.process.dlq';

// Número de reentregas antes de mover pro DLQ (não conta a tentativa
// inicial) — 3 retries = até 4 tentativas de processamento no total.
export const MAX_RETRY_ATTEMPTS = 3;

// Backoff exponencial simples, com teto — mantém os testes e2e rápidos e
// ainda dá um espaçamento real entre tentativas.
export function retryBackoffMs(retryCount: number): number {
  return Math.min(500 * 2 ** retryCount, 5_000);
}

export const PROCESSED_EVENT_DEDUP_TTL_SECONDS = 60 * 60; // 1h
