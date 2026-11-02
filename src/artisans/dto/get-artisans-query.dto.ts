import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export enum ArtisanSortBy {
  RATING = 'rating',
  NEWEST = 'newest',
  EXPERIENCE = 'experience',
  HOURLY_RATE = 'hourlyRate',
}

/**
 * D7: availability window filter, computed in Africa/Accra time from the
 * artisan's Calendar settings. Both values require status AVAILABLE.
 * - `now`: an active weekly slot covers the current Accra time and today
 *   isn't inside time off.
 * - `this_week`: at least one of the next 7 days (today included) has active
 *   weekly hours and isn't inside time off.
 * Existing bookings are NOT checked: a match means the artisan works then,
 * not that a given time is still free (the booking page shows that).
 */
export enum AvailabilityWindow {
  NOW = 'now',
  THIS_WEEK = 'this_week',
}

/**
 * Query parameters accepted by `GET /artisans`.
 * All fields are optional; defaults are applied in the service layer.
 */
export class GetArtisansQueryDto {
  @ApiPropertyOptional({
    example: 1,
    description: 'Filter by service category ID',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  serviceId?: number;

  @ApiPropertyOptional({
    example: 'plumber',
    description: 'Keyword search across name, bio, and business name',
  })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({
    example: 'Accra',
    description: 'Partial, case-insensitive location search',
  })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({
    example: 4.0,
    minimum: 1,
    maximum: 5,
    description: 'Minimum average rating',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5)
  @Type(() => Number)
  minRating?: number;

  @ApiPropertyOptional({
    example: 'AVAILABLE',
    description: 'Filter by availability status (AVAILABLE, BUSY, OFFLINE)',
  })
  @IsOptional()
  @IsString()
  availabilityStatus?: string;

  @ApiPropertyOptional({
    enum: AvailabilityWindow,
    example: AvailabilityWindow.NOW,
    description:
      'D7: computed in Africa/Accra time from weekly hours, time off and status ' +
      '(AVAILABLE required). "now": an active weekly slot covers the current time ' +
      'and today is not time off. "this_week": one of the next 7 days (today ' +
      'included) has active hours and is not time off. Existing bookings are not ' +
      'checked, so a match does not guarantee a particular time is free.',
  })
  @IsOptional()
  @IsEnum(AvailabilityWindow)
  availabilityWindow?: AvailabilityWindow;

  @ApiPropertyOptional({
    example: 20,
    description: 'D4: minimum service price (GHS), inclusive',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  minPrice?: number;

  @ApiPropertyOptional({
    example: 200,
    description: 'D4: maximum service price (GHS), inclusive',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  maxPrice?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Filter to verified artisans only',
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  isVerified?: boolean;

  @ApiPropertyOptional({
    enum: ArtisanSortBy,
    example: ArtisanSortBy.RATING,
    description: 'Sort field',
  })
  @IsOptional()
  @IsEnum(ArtisanSortBy)
  sortBy?: ArtisanSortBy;

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
    example: 20,
    default: 20,
    description:
      'D6: results per page (max 50). Defaults to 20 to match the PRD.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  limit?: number;
}
