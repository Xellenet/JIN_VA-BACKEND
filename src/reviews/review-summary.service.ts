import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Review } from './entities/review.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { ReviewStatus } from '@common/types/enums';
import { resolveArtisanProfileId } from '../artisan-insights/earnings.util';
import { shareOf } from '../customer-insights/spend.util';

export interface ReviewSummary {
  total: number;
  average: string;
  byStar: Record<'1' | '2' | '3' | '4' | '5', number>;
  fourPlus: number;
  fourPlusShare: number;
  awaitingReply: number;
}

type SummaryRow = Record<string, string | number | null>;

/** Raw aggregate row → the response shape. Exported for tests. */
export function toReviewSummary(row: SummaryRow | undefined): ReviewSummary {
  const n = (k: string) => Number(row?.[k] ?? 0);
  const total = n('total');
  const avg = Number(row?.average ?? 0);
  const fourPlus = n('fourPlus');
  return {
    total,
    average: (Number.isFinite(avg) && total > 0 ? avg : 0).toFixed(2),
    byStar: {
      '1': n('s1'),
      '2': n('s2'),
      '3': n('s3'),
      '4': n('s4'),
      '5': n('s5'),
    },
    fourPlus,
    fourPlusShare: shareOf(fourPlus, total),
    awaitingReply: n('awaitingReply'),
  };
}

/** SQL: a review's whole-star bucket, 1–5 (alias `r`). */
const STAR_SQL = 'LEAST(5, GREATEST(1, FLOOR(r.rating)))';

/**
 * Artisan fixes (B7): the artisan's own review counts, over every ACTIVE
 * review of their profile (the set their list shows). One aggregate query
 * bound to the profile resolved from the JWT subject.
 */
@Injectable()
export class ReviewSummaryService {
  constructor(
    @InjectRepository(Review) private readonly reviews: Repository<Review>,
    @InjectRepository(ArtisanProfile)
    private readonly profiles: Repository<ArtisanProfile>,
  ) {}

  async getMySummary(me: number): Promise<ReviewSummary> {
    const profileId = await resolveArtisanProfileId(this.profiles, me);
    const qb = this.reviews
      .createQueryBuilder('r')
      .select('COUNT(*)', 'total')
      .addSelect('AVG(r.rating)', 'average')
      .addSelect('COUNT(*) FILTER (WHERE r.rating >= 4)', 'fourPlus')
      .addSelect(
        "COUNT(*) FILTER (WHERE r.artisan_reply IS NULL AND COALESCE(TRIM(r.review), '') <> '')",
        'awaitingReply',
      );
    for (const star of [1, 2, 3, 4, 5]) {
      qb.addSelect(`COUNT(*) FILTER (WHERE ${STAR_SQL} = ${star})`, `s${star}`);
    }
    const row = await qb
      .where('r.artisan_profile_id = :profileId', { profileId })
      .andWhere('r.status = :active', { active: ReviewStatus.ACTIVE })
      .getRawOne<SummaryRow>();
    return toReviewSummary(row);
  }
}
