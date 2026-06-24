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

  @Expose() @ApiProperty() scheduledDate!: string;
  @Expose() @ApiProperty() startTime!: string;
  @Expose() @ApiProperty() endTime!: string;

  @Expose() @ApiProperty({ enum: BookingStatus }) status!: BookingStatus;

  @Expose() @ApiPropertyOptional() notes?: string;
  @Expose() @ApiPropertyOptional() artisanNotes?: string;
  @Expose() @ApiPropertyOptional() agreedPrice?: number;
  @Expose() @ApiProperty() currency!: string;

  @Expose() @ApiProperty() createdAt!: Date;
  @Expose() @ApiProperty() updatedAt!: Date;
}
