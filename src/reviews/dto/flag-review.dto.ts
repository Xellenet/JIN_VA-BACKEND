import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { VARIABLES } from '@common/constants/variables.constants';

/** FL1: `POST /reviews/:id/flag` body. Any authenticated user may flag. */
export class FlagReviewDto {
  @ApiProperty({
    example: 'This review looks fake — the reviewer was never a customer.',
    minLength: VARIABLES.REVIEW_FLAG_REASON_MIN_LENGTH,
    maxLength: VARIABLES.REVIEW_FLAG_REASON_MAX_LENGTH,
    description: 'Required — why this review is being reported.',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(VARIABLES.REVIEW_FLAG_REASON_MIN_LENGTH)
  @MaxLength(VARIABLES.REVIEW_FLAG_REASON_MAX_LENGTH)
  reason!: string;
}
