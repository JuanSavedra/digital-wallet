import {
  Controller,
  Get,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { toWalletResponse } from './dto/wallet-response';
import { WalletOwnerGuard } from './guards/wallet-owner.guard';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Get('me')
  async me(@CurrentUser() user: RequestUser) {
    const wallet = await this.walletsService.findByUserId(user.userId);
    if (!wallet) {
      throw new NotFoundException('Carteira não encontrada');
    }
    return toWalletResponse(wallet);
  }

  @UseGuards(WalletOwnerGuard)
  @Get(':id')
  async findOne(@Param('id') id: string) {
    const wallet = await this.walletsService.findById(id);
    if (!wallet) {
      throw new NotFoundException('Carteira não encontrada');
    }
    return toWalletResponse(wallet);
  }
}
