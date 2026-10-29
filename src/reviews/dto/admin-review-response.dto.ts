import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { ReviewResponseDto } from './review-response.dto';

/** One FLAG action recorded against a review, for the admin moderation table/dialog. */
export class ReviewFlagSummaryDto {
  @ApiProperty({ example: 'This review looks fake.' })
  @Expose()
  reason: string;

  @ApiProperty({ example: 'Kwame Asante' })
  @Expose()
  actorName?: string;

  @ApiProperty()
  @Expose()
  createdAt: Date;
}

/**
 * AM2: admin moderation-queue shape — the full public review shape plus
 * every FLAG action recorded against it (reason, who, when), sourced from
 * `review_moderation_actions` since flag reasons no longer live on the
 * review row itself (AM5).
 */
export class AdminReviewResponseDto extends ReviewResponseDto {
  @ApiProperty({ type: [ReviewFlagSummaryDto] })
  @Expose()
  @Type(() => ReviewFlagSummaryDto)
  flags: ReviewFlagSummaryDto[];
}
