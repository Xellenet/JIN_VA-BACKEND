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

export class CreateArtisanProfileDto {
  @ApiPropertyOptional({ example: 'Experienced master plumber and maintenance specialist.' })
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
    description: 'ISO 4217 currency code for the hourly rate (e.g. GHS, USD, EUR)',
  })
  @IsOptional()
  @IsISO4217CurrencyCode()
  currency?: string;

  @ApiPropertyOptional({ example: 'Chamamme Home Services' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  businessName?: string;

  @ApiPropertyOptional({ enum: AvailabilityStatus, example: AvailabilityStatus.AVAILABLE })
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
}
