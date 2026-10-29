import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class AvailabilitySlotResponseDto {
  @Expose()
  @ApiProperty()
  id!: number;

  @Expose()
  @ApiProperty({ description: '0 = Sunday, 1 = Monday, …, 6 = Saturday' })
  dayOfWeek!: number;

  @Expose()
  @ApiProperty({ example: '09:00' })
  startTime!: string;

  @Expose()
  @ApiProperty({ example: '17:00' })
  endTime!: string;

  @Expose()
  @ApiProperty()
  isActive!: boolean;
}

/** R1a: one actually-bookable start/end window on the requested date. */
export class BookableWindowDto {
  @ApiProperty({ example: '09:00' })
  startTime!: string;

  @ApiProperty({ example: '11:00' })
  endTime!: string;
}

export class ArtisanAvailabilityResponseDto {
  @ApiProperty({ description: 'Artisan profile ID' })
  artisanProfileId!: number;

  @ApiProperty({ description: 'AVAILABLE | BUSY | UNAVAILABLE' })
  status!: string;

  @ApiProperty({ type: [AvailabilitySlotResponseDto] })
  slots!: AvailabilitySlotResponseDto[];

  @ApiPropertyOptional({
    description:
      'R1a: only present when a `date` query param was supplied. The actually-bookable ' +
      'windows for that date (weekly hours minus A1 blocks minus PENDING/CONFIRMED bookings).',
    example: '2026-08-24',
  })
  date?: string;

  @ApiPropertyOptional({
    type: [BookableWindowDto],
    description:
      'R1a: only present when a `date` query param was supplied. Empty array means no ' +
      'bookable time remains on that date (fully booked, blocked, or no configured hours).',
  })
  bookableSlots?: BookableWindowDto[];
}

/** A1: an artisan-declared block, as returned to the owning artisan. */
export class BlockedSlotResponseDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() startDate!: string;
  @Expose() @ApiProperty() endDate!: string;
  @Expose() @ApiPropertyOptional() reason?: string;
  @Expose() @ApiProperty() createdAt!: Date;
}
