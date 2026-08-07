import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

const MAX_DEPOSIT_CENTS = 10_000_00; // R$ 10.000,00 por depósito

export class DepositDto {
  @ApiProperty({
    description: 'Valor em centavos',
    example: 10000,
    minimum: 1,
    maximum: MAX_DEPOSIT_CENTS,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_DEPOSIT_CENTS)
  amount!: number;
}
