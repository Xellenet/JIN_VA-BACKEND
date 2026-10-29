import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { VARIABLES } from '@common/constants/variables.constants';

/** AR1: `POST /reviews/:id/replies` body. */
export class CreateReviewReplyDto {
  @ApiProperty({
    example:
      "Thank you for the feedback — we've since retrained our team on this.",
    minLength: VARIABLES.REVIEW_REPLY_MIN_LENGTH,
    maxLength: VARIABLES.REVIEW_REPLY_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(VARIABLES.REVIEW_REPLY_MIN_LENGTH)
  @MaxLength(VARIABLES.REVIEW_REPLY_MAX_LENGTH)
  reply!: string;
}
