import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { DepositsService } from './deposits.service';
import { WalletOwnerGuard } from './guards/wallet-owner.guard';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  imports: [PaymentsModule],
  controllers: [WalletsController],
  providers: [WalletsService, WalletOwnerGuard, DepositsService],
  exports: [WalletsService],
})
export class WalletsModule {}
