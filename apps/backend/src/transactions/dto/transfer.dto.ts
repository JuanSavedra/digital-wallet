import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Min } from 'class-validator';

export class TransferDto {
  @ApiProperty({ description: 'Id da carteira de destino' })
  @IsUUID()
  destinationWalletId!: string;

  @ApiProperty({ description: 'Valor em centavos', example: 1000, minimum: 1 })
  @IsInt()
  @Min(1)
  amount!: number;
}
