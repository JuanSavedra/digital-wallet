import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { NormalizeEmail } from '../../common/transforms/normalize-email';

// bcrypt ignora silenciosamente tudo além de 72 bytes: sem este teto, duas
// senhas diferentes que compartilham os primeiros 72 bytes autenticariam
// uma à outra, e o usuário nunca saberia que o resto da senha é decorativo.
export const MAX_PASSWORD_LENGTH = 72;

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @MaxLength(254)
  @NormalizeEmail()
  email!: string;

  @ApiProperty({
    example: 'senha-forte-123',
    minLength: 8,
    maxLength: MAX_PASSWORD_LENGTH,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(MAX_PASSWORD_LENGTH)
  password!: string;
}
