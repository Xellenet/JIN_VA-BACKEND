import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { BookingStatus } from '@common/types/enums';

class BookingCustomerDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() firstname!: string;
  @Expose() @ApiProperty() lastname!: string;
  @Expose() @ApiPropertyOptional() profilePicture?: string;
}

class BookingArtisanUserDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() firstname!: string;
  @Expose() @ApiProperty() lastname!: string;
  @Expose() @ApiPropertyOptional() profilePicture?: string;
}

class BookingArtisanProfileDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiPropertyOptional() businessName?: string;
  @Expose()
  @ApiPropertyOptional({ type: BookingArtisanUserDto })
  @Type(() => BookingArtisanUserDto)
  user?: BookingArtisanUserDto;
}

class BookingSlotDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() dayOfWeek!: number;
  @Expose() @ApiProperty() startTime!: string;
  @Expose() @ApiProperty() endTime!: string;
}

class BookingServiceDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() name!: string;
}

export class BookingResponseDto {
  @Expose() @ApiProperty() id!: number;

  @Expose()
  @ApiProperty({ type: BookingCustomerDto })
  @Type(() => BookingCustomerDto)
  customer!: BookingCustomerDto;

  @Expose()
  @ApiProperty({ type: BookingArtisanProfileDto })
  @Type(() => BookingArtisanProfileDto)
  artisanProfile!: BookingArtisanProfileDto;

  @Expose()
  @ApiPropertyOptional({ type: BookingSlotDto })
  @Type(() => BookingSlotDto)
  availabilitySlot?: BookingSlotDto;

  @Expose()
  @ApiPropertyOptional({ type: BookingServiceDto })
  @Type(() => BookingServiceDto)
  service?: BookingServiceDto;

  @Expose() @ApiProperty() scheduledDate!: string;
  @Expose() @ApiProperty() startTime!: string;
  @Expose() @ApiProperty() endTime!: string;

  @Expose() @ApiProperty({ enum: BookingStatus }) status!: BookingStatus;

  @Expose() @ApiPropertyOptional() notes?: string;
  @Expose() @ApiPropertyOptional() artisanNotes?: string;
  @Expose() @ApiPropertyOptional() agreedPrice?: number;
  @Expose() @ApiProperty() currency!: string;

  @Expose()
  @ApiPropertyOptional({ type: [String] })
  attachmentUrls?: string[];

  @Expose()
  @ApiPropertyOptional({
    description: 'A6: set when the customer flagged the artisan as a no-show.',
  })
  noShowByCustomerAt?: Date;

  @Expose()
  @ApiPropertyOptional({
    description: 'A6: set when the artisan flagged the customer as a no-show.',
  })
  noShowByArtisanAt?: Date;

  @Expose()
  @ApiPropertyOptional({
    description: 'R2: the job created when this booking was confirmed, if any.',
  })
  jobId?: number;

  @Expose() @ApiProperty() createdAt!: Date;
  @Expose() @ApiProperty() updatedAt!: Date;
}
