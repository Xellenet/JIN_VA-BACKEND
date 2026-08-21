import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { VARIABLES } from '@common/constants/variables.constants';

export class CreateServiceDto {
  @ApiProperty({ example: 'Plumbing' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({
    example: 'Pipe repairs, drain cleaning, bathroom fittings.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    example: 60,
    description:
      'A2: estimated duration in minutes (5–480). Defaults to the platform default if omitted.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(VARIABLES.MIN_SERVICE_DURATION_MINS)
  @Max(VARIABLES.MAX_SERVICE_DURATION_MINS)
  estimatedDurationMins?: number;
}
