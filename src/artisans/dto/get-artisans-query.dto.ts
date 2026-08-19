import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export enum ArtisanSortBy {
  RATING     = 'rating',
  NEWEST     = 'newest',
  EXPERIENCE = 'experience',
  HOURLY_RATE = 'hourlyRate',
}

/**
 * Query parameters accepted by `GET /artisans`.
 * All fields are optional; defaults are applied in the service layer.
 */
export class GetArtisansQueryDto {
  @ApiPropertyOptional({ example: 1, description: 'Filter by service category ID' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  serviceId?: number;

  @ApiPropertyOptional({ example: 'plumber', description: 'Keyword search across name, bio, and business name' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ example: 'Accra', description: 'Partial, case-insensitive location search' })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({ example: 4.0, minimum: 1, maximum: 5, description: 'Minimum average rating' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5)
  @Type(() => Number)
  minRating?: number;

  @ApiPropertyOptional({ example: 'AVAILABLE', description: 'Filter by availability status (AVAILABLE, BUSY, OFFLINE)' })
  @IsOptional()
  @IsString()
  availabilityStatus?: string;

  @ApiPropertyOptional({ example: true, description: 'Filter to verified artisans only' })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  isVerified?: boolean;

  @ApiPropertyOptional({ enum: ArtisanSortBy, example: ArtisanSortBy.RATING, description: 'Sort field' })
  @IsOptional()
  @IsEnum(ArtisanSortBy)
  sortBy?: ArtisanSortBy;

  @ApiPropertyOptional({ example: 1, default: 1, description: 'Page number (1-based)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ example: 10, default: 10, description: 'Results per page (max 50)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  limit?: number;
}
