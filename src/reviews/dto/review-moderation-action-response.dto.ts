import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { ModerationAction } from '@common/types/enums';

/** AM5: one row of `GET /admin/reviews/moderation-log`. */
export class ReviewModerationActionResponseDto {
  @ApiProperty({ example: 5 })
  @Expose()
  id: number;

  @ApiProperty({
    example: 42,
    description: 'The id the review had before it may have been deleted.',
  })
  @Expose()
  reviewId: number;

  @ApiProperty({ enum: ModerationAction })
  @Expose()
  action: ModerationAction;

  @ApiPropertyOptional({ example: 'Confirmed fake review.' })
  @Expose()
  reason?: string | null;

  @ApiProperty({ example: 3 })
  @Expose()
  actorId: number;

  @ApiPropertyOptional({ example: 'Ama Owusu (admin)' })
  @Expose()
  actorName?: string;

  @ApiPropertyOptional({ example: 'ADMIN' })
  @Expose()
  actorRole?: string;

  @ApiPropertyOptional({ example: 'Kwame Asante' })
  @Expose()
  reviewerName?: string;

  @ApiPropertyOptional({ example: 'Kofi Home Services' })
  @Expose()
  artisanName?: string;

  @ApiPropertyOptional({ example: 1.0 })
  @Expose()
  rating?: number;

  @ApiPropertyOptional({
    example: 'This was a terrible experience because...',
  })
  @Expose()
  reviewExcerpt?: string;

  @ApiProperty()
  @Expose()
  createdAt: Date;
}
