import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { DisputeStatus } from '@common/types/enums';

class DisputeUserDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() firstname!: string;
  @Expose() @ApiProperty() lastname!: string;
  @Expose() @ApiPropertyOptional() profilePicture?: string;
}

class DisputeBookingDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() scheduledDate!: string;
  @Expose() @ApiProperty() status!: string;
  @Expose() @ApiPropertyOptional() agreedPrice?: number;
}

export class DisputeResponseDto {
  @Expose() @ApiProperty() id!: number;

  @Expose()
  @ApiProperty({ type: DisputeBookingDto })
  @Type(() => DisputeBookingDto)
  booking!: DisputeBookingDto;

  @Expose()
  @ApiProperty({ type: DisputeUserDto })
  @Type(() => DisputeUserDto)
  raisedBy!: DisputeUserDto;

  @Expose() @ApiProperty() reason!: string;

  @Expose()
  @ApiProperty({ enum: DisputeStatus })
  status!: DisputeStatus;

  @Expose() @ApiPropertyOptional() adminNotes?: string;
  @Expose() @ApiPropertyOptional() resolution?: string;

  @Expose()
  @ApiPropertyOptional({ type: DisputeUserDto })
  @Type(() => DisputeUserDto)
  resolvedBy?: DisputeUserDto;

  @Expose() @ApiPropertyOptional() resolvedAt?: Date;
  @Expose() @ApiProperty() createdAt!: Date;
  @Expose() @ApiProperty() updatedAt!: Date;
}
