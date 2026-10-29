import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

/** R1a: optional date param that activates the actually-bookable-windows computation. */
export class GetAvailabilityQueryDto {
  @ApiPropertyOptional({
    example: '2026-08-24',
    description:
      'When supplied, the response also includes `bookableSlots` for that date ' +
      '(weekly hours minus A1 blocks minus PENDING/CONFIRMED bookings). Omit to preserve ' +
      'the legacy raw-weekly-template response.',
  })
  @IsOptional()
  @IsDateString()
  date?: string;
}
