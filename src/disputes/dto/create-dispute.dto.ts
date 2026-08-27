import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { DisputeCategory } from '@common/types/enums';

export class CreateDisputeDto {
  @ApiProperty({ example: 1, description: 'ID of the booking being disputed' })
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  bookingId!: number;

  /**
   * DR5: required on every new dispute. Existing rows filed before this field
   * existed have no category and read back as `OTHER`.
   */
  @ApiProperty({
    enum: DisputeCategory,
    example: DisputeCategory.WORK_NOT_COMPLETED,
    description:
      'Fixed-list category for the dispute. Drives the admin queue badge and the server-side category filter.',
  })
  @IsEnum(DisputeCategory)
  category!: DisputeCategory;

  @ApiProperty({
    example:
      'The artisan did not complete the agreed work and is refusing to return.',
    description: 'Detailed reason for raising the dispute',
  })
  @IsString()
  @MinLength(20, {
    message: 'Please provide a detailed reason (at least 20 characters).',
  })
  @MaxLength(2000)
  reason!: string;
}
