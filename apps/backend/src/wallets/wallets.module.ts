import { Module } from '@nestjs/common';
import { WalletOwnerGuard } from './guards/wallet-owner.guard';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  controllers: [WalletsController],
  providers: [WalletsService, WalletOwnerGuard],
  exports: [WalletsService],
})
export class WalletsModule {}
