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

/** One window of time in a day, 24-hour HH:MM in Africa/Accra. */
export class TimeWindowDto {
  @ApiProperty({ example: '08:00' })
  startTime!: string;

  @ApiProperty({ example: '17:00' })
  endTime!: string;
}

/**
 * What clients are told about an artisan's availability, computed in
 * Africa/Accra time from the artisan's Calendar settings: weekly hours, time
 * off and status, plus PENDING/CONFIRMED bookings.
 */
export class AvailabilitySummaryDto {
  @ApiProperty({
    enum: [
      'available_today',
      'next_available',
      'on_time_off',
      'no_hours',
      'busy',
      'unavailable',
    ],
    example: 'available_today',
    description:
      'BUSY/UNAVAILABLE status wins; then no_hours (no active weekly hours); then ' +
      'on_time_off (today is inside time off); then available_today (hours left ' +
      'today); otherwise next_available (see nextAvailableDate, which may be null).',
  })
  state!: string;

  @ApiProperty({
    example: '2026-11-02',
    description: 'The Accra calendar date this was computed for.',
  })
  today!: string;

  @ApiProperty({ example: true })
  hasWorkingHours!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'Last day (YYYY-MM-DD) of the time off covering today, back-to-back ranges merged.',
  })
  onTimeOffUntil!: string | null;

  @ApiProperty({
    type: [TimeWindowDto],
    description: "Today's active weekly hours (not reduced by bookings).",
  })
  todayHours!: TimeWindowDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-11-02',
    description:
      'First date in the next 14 days (today included) with working hours, no time ' +
      'off and time not already booked. Null when there is none.',
  })
  nextAvailableDate!: string | null;

  @ApiProperty({
    example: true,
    description:
      'Clients can request a booking within the next 14 days (status AVAILABLE and a nextAvailableDate).',
  })
  bookable!: boolean;
}

/** One active weekly working-hours window, as shown to clients. */
export class PublicWeeklyHoursDto {
  @ApiProperty({ description: '0 = Sunday, 1 = Monday, …, 6 = Saturday' })
  dayOfWeek!: number;

  @ApiProperty({ example: '08:00' })
  startTime!: string;

  @ApiProperty({ example: '12:00' })
  endTime!: string;
}

/** Upcoming time off, as shown to clients: dates only, never the reason. */
export class PublicTimeOffDto {
  @ApiProperty({ example: '2026-11-10' })
  startDate!: string;

  @ApiProperty({ example: '2026-11-12' })
  endDate!: string;
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

  @ApiPropertyOptional({
    type: AvailabilitySummaryDto,
    description:
      'What clients currently see for this artisan (same computation as search and the public profile).',
  })
  summary?: AvailabilitySummaryDto;
}

/** A1: an artisan-declared block, as returned to the owning artisan. */
export class BlockedSlotResponseDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() startDate!: string;
  @Expose() @ApiProperty() endDate!: string;
  @Expose() @ApiPropertyOptional() reason?: string;
  @Expose() @ApiProperty() createdAt!: Date;
}
