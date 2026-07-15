import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { AvailabilityStatus } from '@common/types/enums';

export class SetAvailabilityStatusDto {
  @ApiProperty({
    enum: AvailabilityStatus,
    description: 'Your current availability status visible to customers',
  })
  @IsEnum(AvailabilityStatus)
  status!: AvailabilityStatus;
}
