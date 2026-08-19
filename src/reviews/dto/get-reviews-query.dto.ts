import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * Query parameters accepted by the reviews list endpoints.
 * All fields are optional; defaults are applied in the service layer.
 */
export class GetReviewsQueryDto {
  @ApiPropertyOptional({ example: 3.5, description: 'Return only reviews with a rating >= this value' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5)
  @Type(() => Number)
  minRating?: number;

  @ApiPropertyOptional({ example: 1, default: 1, description: 'Page number (1-based)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ example: 10, default: 10, description: 'Number of results per page (max 50)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  limit?: number;
}
