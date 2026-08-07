import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { isUUID } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { toTransactionResponse } from './dto/transaction-response';
import { TransferDto } from './dto/transfer.dto';
import { TransactionsService } from './transactions.service';

const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

@ApiTags('transactions')
@ApiBearerAuth()
// Rate limit por rota (nunca global — como APP_GUARD isso já quebrou os
// testes que criam muitos usuários). O teto de transferências é o ponto
// mais sensível: sem ele, uma conta comprometida pode ser esvaziada em
// centenas de transferências pequenas antes de qualquer alerta, e cada
// chamada ainda segura dois locks distribuídos de carteira.
@UseGuards(JwtAuthGuard, ThrottlerGuard)
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @Post('transfer')
  async transfer(
    @CurrentUser() user: RequestUser,
    @Body() dto: TransferDto,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey: string | undefined,
  ) {
    if (!idempotencyKey || !isUUID(idempotencyKey)) {
      throw new BadRequestException(
        'Header Idempotency-Key é obrigatório e deve ser um UUID',
      );
    }

    const transaction = await this.transactionsService.transfer(
      user.userId,
      dto,
      idempotencyKey,
    );
    return toTransactionResponse(transaction);
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const transaction = await this.transactionsService.findByIdForUser(
      id,
      user.userId,
    );
    return toTransactionResponse(transaction);
  }
}
