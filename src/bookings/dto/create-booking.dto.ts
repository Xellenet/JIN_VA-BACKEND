import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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

export class CreateBookingDto {
  @ApiProperty({ example: 1, description: 'Artisan profile ID to book' })
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  artisanProfileId!: number;

  @ApiPropertyOptional({ example: 3, description: 'Availability slot ID to reference (optional)' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  availabilitySlotId?: number;

  @ApiProperty({ example: '2026-07-15', description: 'Requested date (YYYY-MM-DD)' })
  @IsDateString()
  scheduledDate!: string;

  @ApiProperty({ example: '09:00', description: 'Start time (HH:MM 24-hour)' })
  @Matches(/^\d{2}:\d{2}$/, { message: 'startTime must be HH:MM' })
  startTime!: string;

  @ApiProperty({ example: '11:00', description: 'End time (HH:MM 24-hour)' })
  @Matches(/^\d{2}:\d{2}$/, { message: 'endTime must be HH:MM' })
  endTime!: string;

  @ApiPropertyOptional({ example: 'Please bring your own tools.', description: 'Notes to the artisan' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({ example: 150.00, description: 'Agreed price for the service' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  agreedPrice?: number;

  @ApiPropertyOptional({ example: 'GHS', description: 'ISO 4217 currency code for agreedPrice' })
  @IsOptional()
  @IsISO4217CurrencyCode()
  currency?: string;
}
