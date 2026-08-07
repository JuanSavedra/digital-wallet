import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

describe('MetricsController', () => {
  it('returns the prometheus exposition text from the registry', async () => {
    const metricsService = new MetricsService();
    metricsService.setDlqSize(2);
    const controller = new MetricsController(metricsService);

    const body = await controller.getMetrics();

    expect(body).toContain('wallet_dlq_size 2');
  });
});
