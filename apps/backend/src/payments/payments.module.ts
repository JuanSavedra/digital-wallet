import { Module } from '@nestjs/common';
import { AbacatePayService } from './abacatepay.service';

@Module({
  providers: [AbacatePayService],
  exports: [AbacatePayService],
})
export class PaymentsModule {}
