import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { VARIABLES } from '@common/constants/variables.constants';

/**
 * AM3: `PATCH /admin/reviews/:id/remove` body. Admin-only. The reason is
 * captured in the `review_moderation_actions` log (AM5) before the review
 * row is permanently deleted.
 */
export class RemoveReviewDto {
  @ApiProperty({
    example: 'Confirmed fake review after investigating the linked job.',
    minLength: VARIABLES.REVIEW_MODERATION_REASON_MIN_LENGTH,
    maxLength: VARIABLES.REVIEW_MODERATION_REASON_MAX_LENGTH,
    description: 'Required — permanently logged before the review is deleted.',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(VARIABLES.REVIEW_MODERATION_REASON_MIN_LENGTH)
  @MaxLength(VARIABLES.REVIEW_MODERATION_REASON_MAX_LENGTH)
  reason!: string;
}
