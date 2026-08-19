import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  MaxLength,
  IsString,
} from 'class-validator';

export class CreateCustomerProfileDto {
  @ApiPropertyOptional({ example: 'I prefer weekend appointments and nearby providers.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  bio?: string;

  @ApiPropertyOptional({
    example: [1, 2, 3],
    description: 'Service IDs that this customer prefers',
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  preferredServiceIds?: number[];

  @ApiPropertyOptional({ example: 30 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  budgetMin?: number;

  @ApiPropertyOptional({ example: 120 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  budgetMax?: number;
}
