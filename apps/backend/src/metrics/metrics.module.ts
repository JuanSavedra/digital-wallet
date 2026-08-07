import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsTokenGuard } from './metrics-token.guard';
import { MetricsService } from './metrics.service';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, MetricsTokenGuard],
  exports: [MetricsService],
})
export class MetricsModule {}
