import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsPositive, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateDisputeDto {
  @ApiProperty({ example: 1, description: 'ID of the booking being disputed' })
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  bookingId!: number;

  @ApiProperty({
    example: 'The artisan did not complete the agreed work and is refusing to return.',
    description: 'Detailed reason for raising the dispute',
  })
  @IsString()
  @MinLength(20, { message: 'Please provide a detailed reason (at least 20 characters).' })
  @MaxLength(2000)
  reason!: string;
}
