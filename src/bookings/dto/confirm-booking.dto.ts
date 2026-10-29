import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, Min } from 'class-validator';
import { RespondBookingDto } from './respond-booking.dto';

/**
 * QA JOB-22: confirming a booking creates the payment the customer makes
 * before work starts, so the booking needs a price. The artisan sets it here
 * when the customer didn't agree one at booking time.
 */
export class ConfirmBookingDto extends RespondBookingDto {
  @ApiPropertyOptional({
    example: 150,
    description:
      "The artisan's price for this booking in GHS. Required when the booking has no agreed price.",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: 'price must be greater than 0' })
  price?: number;
}
