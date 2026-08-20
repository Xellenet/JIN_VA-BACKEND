import { ApiProperty } from '@nestjs/swagger';
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

export class ArtisanAvailabilityResponseDto {
  @ApiProperty({ description: 'Artisan profile ID' })
  artisanProfileId!: number;

  @ApiProperty({ description: 'AVAILABLE | BUSY | UNAVAILABLE' })
  status!: string;

  @ApiProperty({ type: [AvailabilitySlotResponseDto] })
  slots!: AvailabilitySlotResponseDto[];
}
