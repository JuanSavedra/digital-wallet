import { Controller, Get, Header, VERSION_NEUTRAL } from '@nestjs/common';
import { MetricsService } from './metrics.service';

// Sem versionamento de URI (fica em /api/metrics, não /api/v1/metrics) —
// scrapers do Prometheus configuram um path fixo, não um por versão de API.
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    return this.metricsService.registry.metrics();
  }
}
