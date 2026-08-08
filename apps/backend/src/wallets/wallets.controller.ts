import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DepositsService } from './deposits.service';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { toDepositResponse } from './dto/deposit-response';
import { LookupQueryDto } from './dto/lookup-query.dto';
import { StatementQueryDto } from './dto/statement-query.dto';
import { toWalletResponse } from './dto/wallet-response';
import { WalletOwnerGuard } from './guards/wallet-owner.guard';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ThrottlerGuard)
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly walletsService: WalletsService,
    private readonly depositsService: DepositsService,
  ) {}

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
    const statement = await this.walletsService.getStatement(
      wallet.id,
      query.page,
    );
    return { page: query.page, ...statement };
  }

  // Cada chamada cria um produto E um checkout na AbacatePay: sem limite,
  // um único usuário consegue inundar a conta do gateway com objetos.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('me/deposits')
  @HttpCode(HttpStatus.CREATED)
  async createDeposit(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateDepositDto,
  ) {
    const deposit = await this.depositsService.createDeposit(
      user.userId,
      dto.amount,
    );
    return toDepositResponse(deposit);
  }

  // O polling do frontend bate aqui a cada 3s e cada consulta pendente
  // dispara uma chamada externa (`/checkouts/list`) — o teto evita
  // transformar o nosso endpoint em amplificador contra a AbacatePay.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('me/deposits/:id')
  async getDeposit(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const deposit = await this.depositsService.getDepositForUser(
      id,
      user.userId,
    );
    return toDepositResponse(deposit);
  }

  // Este endpoint responde "existe/não existe" para um e-mail qualquer —
  // é um oráculo de enumeração de usuários por natureza (necessário para a
  // tela de transferência funcionar por e-mail). O limite baixo mantém o
  // uso legítimo, um destinatário por vez, e inviabiliza varredura de lista.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
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
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const wallet = await this.walletsService.findById(id);
    if (!wallet) {
      throw new NotFoundException('Carteira não encontrada');
    }
    const balance = await this.walletsService.getCachedBalance(wallet.id);
    return toWalletResponse(wallet, balance);
  }

  @UseGuards(WalletOwnerGuard)
  @Get(':id/statement')
  async statement(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: StatementQueryDto,
  ) {
    const statement = await this.walletsService.getStatement(id, query.page);
    return { page: query.page, ...statement };
  }
}
