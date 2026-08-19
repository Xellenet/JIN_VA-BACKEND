import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsISO4217CurrencyCode,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AvailabilityStatus } from '@common/types/enums';

/** F7: sane upper bound for a service radius in kilometres. */
const MAX_SERVICE_RADIUS_KM = 500;
/** F6: cancellation policy is free text — cap length like `bio`. */
const MAX_CANCELLATION_POLICY_LENGTH = 1000;

export class CreateArtisanProfileDto {
  @ApiPropertyOptional({
    example: 'Experienced master plumber and maintenance specialist.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  bio?: string;

  @ApiPropertyOptional({ example: 8 })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Min(1)
  @Max(80)
  experienceYears?: number;

  @ApiPropertyOptional({ example: 45.5 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  hourlyRate?: number;

  @ApiPropertyOptional({
    example: 'GHS',
    description:
      'ISO 4217 currency code for the hourly rate (e.g. GHS, USD, EUR)',
  })
  @IsOptional()
  @IsISO4217CurrencyCode()
  currency?: string;

  @ApiPropertyOptional({ example: 'Chamamme Home Services' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  businessName?: string;

  @ApiPropertyOptional({
    enum: AvailabilityStatus,
    example: AvailabilityStatus.AVAILABLE,
  })
  @IsOptional()
  @IsEnum(AvailabilityStatus)
  availabilityStatus?: string;

  @ApiPropertyOptional({
    example: [1, 2, 3],
    description: 'Service IDs that this artisan offers',
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  serviceIds?: number[];

  @ApiPropertyOptional({
    example: 'Accra, Ghana',
    description: 'Service area / primary location (F7)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  location?: string;

  @ApiPropertyOptional({
    example: 25,
    description:
      'Service radius in kilometres — how far the artisan is willing to travel for work (F7)',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(MAX_SERVICE_RADIUS_KM)
  serviceRadiusKm?: number;

  @ApiPropertyOptional({
    example:
      'Free cancellation up to 24 hours before the scheduled job; 50% fee thereafter.',
    description:
      "Artisan's cancellation policy, shown on their public profile (F6)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CANCELLATION_POLICY_LENGTH)
  cancellationPolicy?: string;
}
