import { Injectable } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export type CacheName = 'wallet_balance' | 'wallet_statement';
export type TransferErrorReason =
  | 'insufficient_balance'
  | 'lock_conflict'
  | 'concurrent_modification'
  | 'not_found'
  | 'validation'
  | 'unexpected';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  private readonly transferDuration = new Histogram({
    name: 'wallet_transfer_duration_seconds',
    help: 'Duração de transferências entre carteiras, do início ao fim do handler',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [this.registry],
  });

  private readonly transferErrors = new Counter({
    name: 'wallet_transfer_errors_total',
    help: 'Total de transferências que falharam, por motivo',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  private readonly cacheHits = new Counter({
    name: 'wallet_cache_hits_total',
    help: 'Total de acertos de cache (cache-aside), por cache',
    labelNames: ['cache'],
    registers: [this.registry],
  });

  private readonly cacheMisses = new Counter({
    name: 'wallet_cache_misses_total',
    help: 'Total de faltas de cache (cache-aside), por cache',
    labelNames: ['cache'],
    registers: [this.registry],
  });

  private readonly dlqSize = new Gauge({
    name: 'wallet_dlq_size',
    help: 'Quantidade de mensagens atualmente na dead-letter queue de transações',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  startTransferTimer(): () => void {
    const endTimer = this.transferDuration.startTimer();
    return () => endTimer();
  }

  recordTransferError(reason: TransferErrorReason): void {
    this.transferErrors.inc({ reason });
  }

  recordCacheHit(cache: CacheName): void {
    this.cacheHits.inc({ cache });
  }

  recordCacheMiss(cache: CacheName): void {
    this.cacheMisses.inc({ cache });
  }

  setDlqSize(size: number): void {
    this.dlqSize.set(size);
  }
}
