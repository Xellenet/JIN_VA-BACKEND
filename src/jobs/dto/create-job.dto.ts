import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { IsAttachmentUrl } from '@common/validators/is-attachment-url.decorator';

export class CreateJobDto {
  @ApiProperty({
    example: 'Leaky faucet repair',
    description: 'Short job title (max 150 chars)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  title!: string;

  @ApiPropertyOptional({
    example:
      'The kitchen faucet has been leaking for two days and needs to be fixed urgently.',
    description: 'Full description of work required (max 2000 chars)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    example: 1,
    description: 'ID of the service category this job belongs to',
  })
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  serviceId!: number;

  @ApiProperty({
    example: 'Accra, Ghana',
    description: 'Human-readable job location (max 200 chars)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  location!: string;

  @ApiPropertyOptional({
    example: 50,
    description: 'Minimum acceptable budget (>= 0)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  budgetMin?: number;

  @ApiPropertyOptional({
    example: 500,
    description: 'Maximum acceptable budget (>= 0)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  budgetMax?: number;

  @ApiProperty({
    example: 'GHS',
    description:
      'Currency code for the budget amounts. GHS only — the payments ' +
      'integration (Paystack) is hardcoded to Ghana cedis; jobs in any ' +
      'other currency cannot be paid in-app, so job creation rejects them ' +
      'outright rather than creating a payment record that would silently ' +
      'mismatch the real charge amount.',
  })
  @IsIn(['GHS'], {
    message: 'currency must be GHS — only Ghana cedis jobs can be paid in-app',
  })
  currency!: string;

  @ApiPropertyOptional({
    example: 5.6037,
    description: 'Latitude of the job site',
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  latitude?: number;

  @ApiPropertyOptional({
    example: -0.187,
    description: 'Longitude of the job site',
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  longitude?: number;

  @ApiPropertyOptional({
    example: '2026-07-01T00:00:00.000Z',
    description:
      'Optional deadline — after this date the cron job expires the posting automatically',
  })
  @IsOptional()
  @IsDateString()
  deadline?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'J4: photo URLs uploaded beforehand via POST /uploads/job-attachment. ' +
      'Optional — a job may be created with zero attachments.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsAttachmentUrl({ each: true })
  @ArrayMaxSize(10)
  attachmentUrls?: string[];
}
