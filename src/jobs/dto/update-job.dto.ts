import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsISO4217CurrencyCode, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Fields a job owner may update on an existing OPEN job.
 * `serviceId` and `status` are intentionally excluded:
 * - Service category cannot change after creation.
 * - Status transitions are managed through dedicated flows.
 */
export class UpdateJobDto {
  @ApiPropertyOptional({ example: 'Updated: Leaky faucet repair', description: 'Revised job title (max 150 chars)' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  title?: string;

  @ApiPropertyOptional({ example: 'Updated description of the work required.', description: 'Revised job description (max 2000 chars)' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ example: 'Kumasi, Ghana', description: 'Revised job location (max 200 chars)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @ApiPropertyOptional({ example: 100, description: 'Revised minimum budget (>= 0)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  budgetMin?: number;

  @ApiPropertyOptional({ example: 800, description: 'Revised maximum budget (>= 0)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  budgetMax?: number;

  @ApiPropertyOptional({ example: 5.6037, description: 'Revised latitude of the job site' })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  latitude?: number;

  @ApiPropertyOptional({ example: -0.187, description: 'Revised longitude of the job site' })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  longitude?: number;

  @ApiPropertyOptional({
    example: 'USD',
    description: 'ISO 4217 currency code for the budget amounts (e.g. GHS, USD, EUR)',
  })
  @IsOptional()
  @IsISO4217CurrencyCode()
  currency?: string;

  @ApiPropertyOptional({ example: '2026-07-01T00:00:00.000Z', description: 'Revised auto-expire deadline' })
  @IsOptional()
  @IsDateString()
  deadline?: string;
}
