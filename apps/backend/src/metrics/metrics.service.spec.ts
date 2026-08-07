import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;

  beforeEach(() => {
    service = new MetricsService();
  });

  it('exposes transfer duration, transfer errors, cache and dlq metrics in the registry', async () => {
    const stopTimer = service.startTransferTimer();
    stopTimer();
    service.recordTransferError('insufficient_balance');
    service.recordCacheHit('wallet_balance');
    service.recordCacheMiss('wallet_statement');
    service.setDlqSize(4);

    const text = await service.registry.metrics();

    expect(text).toContain('wallet_transfer_duration_seconds');
    expect(text).toContain(
      'wallet_transfer_errors_total{reason="insufficient_balance"} 1',
    );
    expect(text).toContain('wallet_cache_hits_total{cache="wallet_balance"} 1');
    expect(text).toContain(
      'wallet_cache_misses_total{cache="wallet_statement"} 1',
    );
    expect(text).toContain('wallet_dlq_size 4');
  });

  it('accumulates transfer error counts per reason', async () => {
    service.recordTransferError('lock_conflict');
    service.recordTransferError('lock_conflict');
    service.recordTransferError('concurrent_modification');

    const text = await service.registry.metrics();

    expect(text).toContain(
      'wallet_transfer_errors_total{reason="lock_conflict"} 2',
    );
    expect(text).toContain(
      'wallet_transfer_errors_total{reason="concurrent_modification"} 1',
    );
  });
});
