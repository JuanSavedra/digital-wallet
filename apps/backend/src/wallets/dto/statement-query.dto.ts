import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * O teto não é cosmético. `WalletsService.getStatement` pagina em memória:
 * ele busca `skip + PAGE_SIZE` candidatos de **cada** fonte para depois
 * mesclar. Sem `@Max`, um `?page=10000000` viraria um `take` de duzentos
 * milhões de linhas no Postgres — um GET autenticado qualquer derrubaria o
 * banco. 500 páginas cobrem 10 mil lançamentos, muito além do uso real.
 */
export const MAX_STATEMENT_PAGE = 500;

export class StatementQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: MAX_STATEMENT_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_STATEMENT_PAGE)
  page: number = 1;
}
