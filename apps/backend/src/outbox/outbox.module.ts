import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { OutboxCleanupService } from './outbox-cleanup.service';
import { OutboxRelayService } from './outbox-relay.service';

@Module({
  imports: [MessagingModule],
  providers: [OutboxRelayService, OutboxCleanupService],
})
export class OutboxModule {}
