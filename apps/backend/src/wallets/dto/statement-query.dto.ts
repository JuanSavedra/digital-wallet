import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * O teto não é cosmético: sem `@Max`, um `?page=10000000` viraria um `skip`
 * gigante no Postgres — um GET autenticado qualquer poderia forçar a
 * varredura de milhões de linhas. 2000 páginas de `STATEMENT_PAGE_SIZE`
 * cobrem 10 mil lançamentos, muito além do uso real.
 */
export const MAX_STATEMENT_PAGE = 2000;

export class StatementQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: MAX_STATEMENT_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_STATEMENT_PAGE)
  page: number = 1;
}
