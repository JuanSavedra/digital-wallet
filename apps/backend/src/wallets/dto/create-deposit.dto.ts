import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

const MIN_DEPOSIT_CENTS = 100; // R$ 1,00 — piso comum de gateways de cartão
const MAX_DEPOSIT_CENTS = 10_000_00; // R$ 10.000,00 por depósito

export class CreateDepositDto {
  @ApiProperty({
    description: 'Valor em centavos',
    example: 10000,
    minimum: MIN_DEPOSIT_CENTS,
    maximum: MAX_DEPOSIT_CENTS,
  })
  @IsInt()
  @Min(MIN_DEPOSIT_CENTS)
  @Max(MAX_DEPOSIT_CENTS)
  amount!: number;
}
