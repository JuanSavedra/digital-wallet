import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * O refresh token normalmente chega no cookie httpOnly (ver
 * `AuthController`) — o campo no corpo existe só para clientes que não são
 * navegador (curl, testes, integrações), onde não há cookie jar. Por isso é
 * opcional: quem tem o cookie não precisa mandar nada.
 */
export class RefreshTokenDto {
  @ApiPropertyOptional({
    description:
      'Só para clientes não-navegador; no frontend o token vem do cookie httpOnly',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  refreshToken?: string;
}
