import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * Query parameters accepted by `GET /services`.
 * All fields are optional; defaults are applied in the service layer.
 */
export class GetServicesQueryDto {
  @ApiPropertyOptional({
    example: 'plumb',
    description: 'Partial, case-insensitive name search',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    example: 1,
    default: 1,
    description: 'Page number (1-based)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({
    example: 100,
    default: 100,
    description: 'Results per page (max 200)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Type(() => Number)
  limit?: number;

  /**
   * Admins only: include hidden services. Ignored for everyone else, so the
   * public catalogue never shows a hidden service.
   */
  @ApiPropertyOptional({
    example: true,
    description:
      'ADMIN only: include hidden services. Ignored for any other caller.',
  })
  @IsOptional()
  @Transform(({ value }): boolean | undefined => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsBoolean()
  includeInactive?: boolean;
}
