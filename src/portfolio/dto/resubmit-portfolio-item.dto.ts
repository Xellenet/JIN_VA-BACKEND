import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * PF7a: body accepted by `PATCH /portfolio/:id/resubmit` alongside the new
 * file. `tag`/`caption` are optional — omit to keep the previous values.
 */
export class ResubmitPortfolioItemDto {
  @ApiPropertyOptional({ example: 'Plumbing' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  tag?: string;

  @ApiPropertyOptional({
    example: 'Full bathroom pipe replacement, completed in one day.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  caption?: string;
}
