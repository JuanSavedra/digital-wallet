import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DepositDto } from './dto/deposit.dto';
import { LookupQueryDto } from './dto/lookup-query.dto';
import { StatementQueryDto } from './dto/statement-query.dto';
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
    const balance = await this.walletsService.getCachedBalance(wallet.id);
    return toWalletResponse(wallet, balance);
  }

  @Get('me/statement')
  async myStatement(
    @CurrentUser() user: RequestUser,
    @Query() query: StatementQueryDto,
  ) {
    const wallet = await this.walletsService.findByUserId(user.userId);
    if (!wallet) {
      throw new NotFoundException('Carteira não encontrada');
    }
    const entries = await this.walletsService.getStatement(
      wallet.id,
      query.page,
    );
    return { page: query.page, entries };
  }

  /**
   * Não é uma feature de produto (não existe rail de captação externa
   * neste projeto — PIX, cartão etc. estão fora do escopo). Existe só
   * para dar saldo inicial e permitir testar transferências manualmente.
   */
  @HttpCode(HttpStatus.OK)
  @Post('me/deposit')
  async deposit(@CurrentUser() user: RequestUser, @Body() dto: DepositDto) {
    const wallet = await this.walletsService.findByUserId(user.userId);
    if (!wallet) {
      throw new NotFoundException('Carteira não encontrada');
    }
    const updated = await this.walletsService.deposit(
      wallet.id,
      BigInt(dto.amount),
    );
    return toWalletResponse(updated);
  }

  @Get('lookup')
  async lookup(@Query() query: LookupQueryDto) {
    const wallet = await this.walletsService.findByUserEmail(query.email);
    if (!wallet) {
      throw new NotFoundException(
        'Nenhuma carteira encontrada para este e-mail',
      );
    }
    return { walletId: wallet.id };
  }

  @UseGuards(WalletOwnerGuard)
  @Get(':id')
  async findOne(@Param('id') id: string) {
    const wallet = await this.walletsService.findById(id);
    if (!wallet) {
      throw new NotFoundException('Carteira não encontrada');
    }
    const balance = await this.walletsService.getCachedBalance(wallet.id);
    return toWalletResponse(wallet, balance);
  }

  @UseGuards(WalletOwnerGuard)
  @Get(':id/statement')
  async statement(@Param('id') id: string, @Query() query: StatementQueryDto) {
    const entries = await this.walletsService.getStatement(id, query.page);
    return { page: query.page, entries };
  }
}
