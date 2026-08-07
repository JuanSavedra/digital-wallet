import { DlqMetricsPoller } from './dlq-metrics.poller';
import { DlqService } from './dlq.service';
import { MetricsService } from '../metrics/metrics.service';

describe('DlqMetricsPoller', () => {
  let poller: DlqMetricsPoller;
  let dlqService: jest.Mocked<DlqService>;
  let metricsService: jest.Mocked<MetricsService>;

  beforeEach(() => {
    dlqService = { getStatus: jest.fn() } as unknown as jest.Mocked<DlqService>;
    metricsService = {
      setDlqSize: jest.fn(),
    } as unknown as jest.Mocked<MetricsService>;
    poller = new DlqMetricsPoller(dlqService, metricsService);
  });

  it('sets the gauge to the current DLQ message count', async () => {
    dlqService.getStatus.mockResolvedValue({
      queue: 'transactions.process.dlq',
      messageCount: 7,
    });

    await poller.pollDlqSize();

    expect(metricsService.setDlqSize).toHaveBeenCalledWith(7);
  });

  it('does not throw when checking the DLQ status fails', async () => {
    dlqService.getStatus.mockRejectedValue(new Error('rabbitmq indisponível'));

    await expect(poller.pollDlqSize()).resolves.toBeUndefined();
    expect(metricsService.setDlqSize).not.toHaveBeenCalled();
  });
});
