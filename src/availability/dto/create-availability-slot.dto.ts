import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Matches, Max, Min } from 'class-validator';

export class CreateAvailabilitySlotDto {
  @ApiProperty({
    description: 'Day of week: 0 = Sunday, 1 = Monday, …, 6 = Saturday',
    minimum: 0,
    maximum: 6,
    example: 1,
  })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({ description: 'Start time in HH:MM 24-hour format', example: '09:00' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'startTime must be in HH:MM format (e.g. 09:00)' })
  startTime!: string;

  @ApiProperty({ description: 'End time in HH:MM 24-hour format', example: '17:00' })
  @IsString()
  @Matches(/^\d{2}:\d{2}$/, { message: 'endTime must be in HH:MM format (e.g. 17:00)' })
  endTime!: string;
}
