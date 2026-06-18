import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO4217CurrencyCode,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateJobDto {
  @ApiProperty({ example: 'Leaky faucet repair', description: 'Short job title (max 150 chars)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  title!: string;

  @ApiPropertyOptional({
    example: 'The kitchen faucet has been leaking for two days and needs to be fixed urgently.',
    description: 'Full description of work required (max 2000 chars)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ example: 1, description: 'ID of the service category this job belongs to' })
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  serviceId!: number;

  @ApiProperty({ example: 'Accra, Ghana', description: 'Human-readable job location (max 200 chars)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  location!: string;

  @ApiPropertyOptional({ example: 50, description: 'Minimum acceptable budget (>= 0)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  budgetMin?: number;

  @ApiPropertyOptional({ example: 500, description: 'Maximum acceptable budget (>= 0)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  budgetMax?: number;

  @ApiProperty({
    example: 'GHS',
    description: 'ISO 4217 currency code for the budget amounts (e.g. GHS, USD, EUR)',
  })
  @IsISO4217CurrencyCode()
  currency!: string;

  @ApiPropertyOptional({ example: 5.6037, description: 'Latitude of the job site' })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  latitude?: number;

  @ApiPropertyOptional({ example: -0.187, description: 'Longitude of the job site' })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  longitude?: number;
}
