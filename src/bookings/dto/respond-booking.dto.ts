import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RespondBookingDto {
  @ApiPropertyOptional({ example: 'See you then! I will bring the required tools.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  artisanNotes?: string;
}
