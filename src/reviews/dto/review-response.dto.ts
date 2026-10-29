import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { ReviewStatus } from '@common/types/enums';

/**
 * Minimal, non-sensitive user snapshot for a reviewer/reviewed-user on a
 * review. Mirrors `ArtisanPublicUserDto`'s scope exactly (id/name/avatar
 * only) — deliberately excludes email, phone, gender, ban status, etc.
 *
 * Security note: prior to this feature, `ReviewsController`'s endpoints
 * returned the raw `Review` entity (including full `reviewerUser` /
 * `reviewedUser` `User` entities) directly, with no DTO scoping. On these
 * **public, unauthenticated** endpoints that meant every reviewer's and
 * artisan's email, phone number, date of birth, gender, and ban status were
 * exposed on every `GET /reviews*` call. This DTO closes that gap. See
 * `api-contract.md` for the flagged contract note.
 */
export class ReviewUserDto {
  @ApiProperty({ example: 1 })
  @Expose()
  id: number;

  @ApiProperty({ example: 'Ama' })
  @Expose()
  firstname: string;

  @ApiProperty({ example: 'Owusu' })
  @Expose()
  lastname: string;

  @ApiPropertyOptional({ example: '/uploads/avatars/avatar-123.jpg' })
  @Expose()
  profilePicture?: string;
}

/**
 * Minimal job snapshot for a review. Excludes budget/payment/location
 * fields that a public review listing has no need to expose.
 */
export class ReviewJobDto {
  @ApiProperty({ example: 12 })
  @Expose()
  id: number;

  @ApiPropertyOptional({ example: 'Fix leaking kitchen sink' })
  @Expose()
  title?: string;

  @ApiProperty({ example: 'COMPLETED' })
  @Expose()
  status: string;
}

/**
 * Minimal artisan-profile snapshot for a review. Deliberately excludes
 * `weightedRating` (RA2 — never shown as a per-profile number, only used
 * server-side for ranking) and all payout/financial fields, which the raw
 * entity would otherwise have leaked on this public endpoint.
 */
export class ReviewArtisanProfileDto {
  @ApiProperty({ example: 4 })
  @Expose()
  id: number;

  @ApiPropertyOptional({ example: 'Kofi Home Services' })
  @Expose()
  businessName?: string;

  @ApiProperty({ example: 4.5 })
  @Expose()
  averageRating: number;

  @ApiProperty({ example: 12 })
  @Expose()
  totalReviews: number;

  @ApiProperty({ example: false })
  @Expose()
  isVerified: boolean;
}

export class ReviewPhotoDto {
  @ApiProperty({ example: 1 })
  @Expose()
  id: number;

  @ApiProperty({ example: '/uploads/reviews/uuid.jpg' })
  @Expose()
  url: string;

  @ApiProperty({ example: 'image/jpeg' })
  @Expose()
  fileType: string;

  @ApiProperty()
  @Expose()
  createdAt: Date;
}

/**
 * Response shape for every `GET /reviews*` endpoint and the
 * create/update/reply mutation responses. Replaces the previous raw-entity
 * return (see `ReviewUserDto`'s doc comment for why).
 */
export class ReviewResponseDto {
  @ApiProperty({ example: 10 })
  @Expose()
  id: number;

  @ApiProperty({ example: 4.5 })
  @Expose()
  rating: number;

  @ApiPropertyOptional({
    example: 'Fast response and excellent work quality.',
  })
  @Expose()
  review?: string;

  @ApiPropertyOptional({
    example: 'Ama Owusu',
    description:
      'Snapshot of the reviewer name at submission time — survives even if ' +
      'the reviewer account is later deleted (reviewerUser becomes null).',
  })
  @Expose()
  reviewerName?: string;

  @ApiProperty({ enum: ReviewStatus, example: ReviewStatus.ACTIVE })
  @Expose()
  status: ReviewStatus;

  @ApiProperty({
    example: true,
    description:
      'VB1: always true — every review requires a COMPLETED job at write time.',
  })
  @Expose()
  verifiedBooking: boolean;

  @ApiPropertyOptional({
    description: 'RE1: set the moment the original reviewer edits this review.',
  })
  @Expose()
  editedAt?: Date | null;

  @ApiPropertyOptional({
    example: "Thank you for the feedback — we've addressed this.",
    description: "AR1: the reviewed artisan's one-time public reply.",
  })
  @Expose()
  artisanReply?: string | null;

  @ApiPropertyOptional()
  @Expose()
  artisanRepliedAt?: Date | null;

  @ApiProperty({ type: [ReviewPhotoDto] })
  @Expose()
  @Type(() => ReviewPhotoDto)
  photos: ReviewPhotoDto[];

  @ApiPropertyOptional({ type: ReviewUserDto })
  @Expose()
  @Type(() => ReviewUserDto)
  reviewerUser?: ReviewUserDto;

  @ApiProperty({ type: ReviewUserDto })
  @Expose()
  @Type(() => ReviewUserDto)
  reviewedUser: ReviewUserDto;

  @ApiProperty({ type: ReviewArtisanProfileDto })
  @Expose()
  @Type(() => ReviewArtisanProfileDto)
  artisanProfile: ReviewArtisanProfileDto;

  @ApiProperty({ type: ReviewJobDto })
  @Expose()
  @Type(() => ReviewJobDto)
  job: ReviewJobDto;

  @ApiProperty()
  @Expose()
  createdAt: Date;

  @ApiProperty()
  @Expose()
  updatedAt: Date;
}
