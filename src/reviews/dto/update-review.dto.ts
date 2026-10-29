import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * RE1: `PATCH /reviews/:id` body. Both fields optional, but at least one
 * must be provided (enforced in `ReviewsService.update`). Photos are not
 * editable here — RP1 only wires photo attachment at creation time.
 */
export class UpdateReviewDto {
  @ApiPropertyOptional({
    example: 4,
    minimum: 1,
    maximum: 5,
    description: 'Updated rating between 1 and 5',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({
    example: 'On reflection, the follow-up visit resolved the issue quickly.',
    description: 'Updated review text (20–2000 characters)',
    minLength: 20,
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(2000)
  review?: string;
}
