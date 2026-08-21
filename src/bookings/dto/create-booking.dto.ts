import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsInt,
  IsISO4217CurrencyCode,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { IsAttachmentUrl } from '@common/validators/is-attachment-url.decorator';

export class CreateBookingDto {
  @ApiProperty({ example: 1, description: 'Artisan profile ID to book' })
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  artisanProfileId!: number;

  @ApiPropertyOptional({
    example: 3,
    description: 'Availability slot ID to reference (optional)',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  availabilitySlotId?: number;

  @ApiProperty({
    example: 1,
    description:
      'R2/A2: the catalog service being booked. Used to derive endTime ' +
      "(startTime + Service.estimatedDurationMins) when endTime isn't supplied, " +
      'and to populate the Job created when the artisan confirms this booking.',
  })
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  serviceId!: number;

  @ApiProperty({
    example: '2026-07-15',
    description:
      'Requested date (YYYY-MM-DD), interpreted as a UTC calendar date',
  })
  @IsDateString()
  scheduledDate!: string;

  @ApiProperty({
    example: '09:00',
    description:
      'Start time (HH:MM 24-hour), UTC. The frontend must convert the ' +
      "customer's local selection to UTC before sending — never a naive local-time string.",
  })
  @Matches(/^\d{2}:\d{2}$/, { message: 'startTime must be HH:MM' })
  startTime!: string;

  @ApiPropertyOptional({
    example: '11:00',
    description:
      'End time (HH:MM 24-hour), UTC. Optional — if omitted, the server derives it ' +
      "from the service's estimatedDurationMins (A2).",
  })
  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/, { message: 'endTime must be HH:MM' })
  endTime?: string;

  @ApiPropertyOptional({
    example: 'Please bring your own tools.',
    description: 'Notes to the artisan',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({
    example: 150.0,
    description: 'Agreed price for the service',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  agreedPrice?: number;

  @ApiPropertyOptional({
    example: 'GHS',
    description: 'ISO 4217 currency code for agreedPrice',
  })
  @IsOptional()
  @IsISO4217CurrencyCode()
  currency?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'J4: photo URLs uploaded beforehand via the existing upload storage abstraction ' +
      '(e.g. POST /uploads/... equivalent). Copied onto the linked Job when the artisan confirms this booking.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsAttachmentUrl({ each: true })
  @ArrayMaxSize(10)
  attachmentUrls?: string[];
}
