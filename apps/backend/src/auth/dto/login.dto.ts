import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength } from 'class-validator';
import { NormalizeEmail } from '../../common/transforms/normalize-email';
import { MAX_PASSWORD_LENGTH } from './register.dto';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @MaxLength(254)
  @NormalizeEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  // Teto igual ao do registro: sem ele, um POST com uma senha de vários MB
  // vira trabalho de bcrypt gratuito para quem quiser derrubar o login.
  @MaxLength(MAX_PASSWORD_LENGTH)
  password!: string;
}
