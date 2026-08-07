import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class LookupQueryDto {
  @ApiProperty({ example: 'destinatario@example.com' })
  @IsEmail()
  email!: string;
}
