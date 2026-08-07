import { Module } from '@nestjs/common';
import { WalletsModule } from '../wallets/wallets.module';
import { AdminController } from './admin.controller';
import { DlqService } from './dlq.service';
import { RabbitMqService } from './rabbitmq.service';
import { TransactionEventsConsumer } from './transaction-events.consumer';
import { TransactionEventsHandler } from './transaction-events.handler';

@Module({
  imports: [WalletsModule],
  controllers: [AdminController],
  providers: [
    RabbitMqService,
    TransactionEventsConsumer,
    TransactionEventsHandler,
    DlqService,
  ],
  exports: [RabbitMqService],
})
export class MessagingModule {}
