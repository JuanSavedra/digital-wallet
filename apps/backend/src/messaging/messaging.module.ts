import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { DlqService } from './dlq.service';
import { RabbitMqService } from './rabbitmq.service';
import { TransactionEventsConsumer } from './transaction-events.consumer';
import { TransactionEventsHandler } from './transaction-events.handler';

@Module({
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
