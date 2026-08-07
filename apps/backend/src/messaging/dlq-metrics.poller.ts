import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MetricsService } from '../metrics/metrics.service';
import { DlqService } from './dlq.service';

export const DLQ_METRICS_POLL_INTERVAL_MS = 15_000;

/**
 * Mantém a métrica `wallet_dlq_size` atualizada sem depender de alguém
 * chamar `GET /admin/dlq` — o Prometheus só lê o valor já calculado no
 * registry, então precisa de algo populando o gauge periodicamente.
 */
@Injectable()
export class DlqMetricsPoller {
  private readonly logger = new Logger(DlqMetricsPoller.name);

  constructor(
    private readonly dlqService: DlqService,
    private readonly metricsService: MetricsService,
  ) {}

  @Interval(DLQ_METRICS_POLL_INTERVAL_MS)
  async pollDlqSize(): Promise<void> {
    try {
      const status = await this.dlqService.getStatus();
      this.metricsService.setDlqSize(status.messageCount);
    } catch (error) {
      this.logger.error(
        `Falha ao coletar tamanho da DLQ: ${(error as Error).message}`,
      );
    }
  }
}
