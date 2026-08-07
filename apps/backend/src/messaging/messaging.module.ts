import { Module } from '@nestjs/common';
import { AdminGuard } from '../auth/guards/admin.guard';
import { WalletsModule } from '../wallets/wallets.module';
import { AdminController } from './admin.controller';
import { DlqMetricsPoller } from './dlq-metrics.poller';
import { DlqService } from './dlq.service';
import { RabbitMqService } from './rabbitmq.service';
import { TransactionEventsConsumer } from './transaction-events.consumer';
import { TransactionEventsHandler } from './transaction-events.handler';

@Module({
  imports: [WalletsModule],
  controllers: [AdminController],
  providers: [
    AdminGuard,
    RabbitMqService,
    TransactionEventsConsumer,
    TransactionEventsHandler,
    DlqService,
    DlqMetricsPoller,
  ],
  exports: [RabbitMqService],
})
export class MessagingModule {}
