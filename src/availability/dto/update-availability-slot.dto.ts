import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateAvailabilitySlotDto } from './create-availability-slot.dto';

export class UpdateAvailabilitySlotDto extends PartialType(CreateAvailabilitySlotDto) {
  @ApiPropertyOptional({ description: 'Disable a slot without deleting it (still visible in own schedule, hidden from public)' })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
