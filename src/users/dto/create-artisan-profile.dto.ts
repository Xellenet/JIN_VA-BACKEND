import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

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

  @ApiPropertyOptional({ example: 'Chamamme Home Services' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  businessName?: string;

  @ApiPropertyOptional({ example: 'AVAILABLE' })
  @IsOptional()
  @IsString()
  @IsIn(['AVAILABLE', 'BUSY', 'OFFLINE'])
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
