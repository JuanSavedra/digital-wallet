import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';
import { NormalizeEmail } from '../../common/transforms/normalize-email';

export class LookupQueryDto {
  @ApiProperty({ example: 'destinatario@example.com' })
  @IsEmail()
  @MaxLength(254)
  // Mesma normalização do registro/login: sem ela, procurar por
  // `Alice@x.com` não acha a conta cadastrada como `alice@x.com` — e pior,
  // acharia uma conta homógrafa criada de propósito para receber a
  // transferência no lugar dela.
  @NormalizeEmail()
  email!: string;
}
