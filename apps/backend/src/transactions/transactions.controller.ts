import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
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
@UseGuards(JwtAuthGuard)
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @ApiHeader({ name: 'Idempotency-Key', required: true })
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
}
