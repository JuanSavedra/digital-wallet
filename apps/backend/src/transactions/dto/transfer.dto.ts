import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Max, Min } from 'class-validator';

/**
 * Teto por transferência: R$ 1.000.000,00. Além de ser um limite de negócio
 * razoável para uma carteira, ele fecha um buraco concreto — `@IsInt`
 * sozinho aceita `1e21` (o JavaScript considera isso um inteiro), e esse
 * valor estoura o `BIGINT` do Postgres no INSERT da transação, devolvendo
 * 500 em vez de 400 e deixando lixo no log de erro.
 */
export const MAX_TRANSFER_CENTS = 1_000_000_00;

export class TransferDto {
  @ApiProperty({ description: 'Id da carteira de destino' })
  @IsUUID()
  destinationWalletId!: string;

  @ApiProperty({
    description: 'Valor em centavos',
    example: 1000,
    minimum: 1,
    maximum: MAX_TRANSFER_CENTS,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_TRANSFER_CENTS)
  amount!: number;
}
