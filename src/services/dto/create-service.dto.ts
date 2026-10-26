import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { VARIABLES } from '@common/constants/variables.constants';

export class CreateServiceDto {
  @ApiProperty({ example: 'Plumbing' })
  // QA ADM-10: " Plumbing " and "plumbing" are the same service; spaces
  // are trimmed (and runs collapsed) before the duplicate check.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value,
  )
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

  /**
   * QA ADM-11: the entity, the list and the admin form all have a price, but
   * the DTO didn't, so every priced create/edit was rejected. `null` clears it
   * (see UpdateServiceDto); a booking without a price gets one at confirmation.
   */
  @ApiPropertyOptional({
    example: 150,
    description: 'Listed price in GHS. Leave out for "price on request".',
    nullable: true,
  })
  @ValidateIf((_, value) => value !== null)
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: 'price must be greater than 0' })
  @Max(1_000_000)
  price?: number | null;
}
