import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateBlockedSlotDto {
  @ApiProperty({
    example: '2026-08-24',
    description: 'First blocked calendar date (YYYY-MM-DD)',
  })
  @IsDateString()
  startDate!: string;

  @ApiProperty({
    example: '2026-08-26',
    description: 'Last blocked calendar date (YYYY-MM-DD), inclusive',
  })
  @IsDateString()
  endDate!: string;

  @ApiPropertyOptional({ example: 'Personal time off' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
