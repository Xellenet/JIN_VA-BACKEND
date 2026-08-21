import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { Review } from './entities/review.entity';
import { VARIABLES } from '@common/constants/variables.constants';

/**
 * RA2: maintains `C`, the mean rating across the whole platform, used by
 * the Bayesian weighted-rating formula. Recomputing this on every single
 * review write would be wasteful at scale, so it's instead computed once at
 * startup and refreshed on a periodic cron — a plain in-memory cache with a
 * long-ish TTL (enforced by the cron interval, not a literal TTL check).
 *
 * Includes both `ACTIVE` and `FLAGGED` reviews in the average (a `REMOVED`
 * review is hard-deleted and can never be included) — consistent with the
 * "a flagged review still counts toward aggregation" decision (RA1).
 *
 * Chosen refresh cadence: every 6 hours. The platform-wide mean moves slowly
 * by nature (it's an average over every review ever written), so a few
 * hours of staleness has no meaningful effect on ranking quality — tune
 * `CronExpression` here if that assumption changes.
 */
@Injectable()
export class PlatformRatingCacheService implements OnModuleInit {
  private readonly logger = new Logger(PlatformRatingCacheService.name);
  private cachedMean = VARIABLES.PLATFORM_MEAN_DEFAULT_RATING;

  constructor(
    @InjectRepository(Review)
    private readonly reviewsRepository: Repository<Review>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  @Cron(CronExpression.EVERY_6_HOURS)
  async refresh(): Promise<void> {
    const raw = await this.reviewsRepository
      .createQueryBuilder('review')
      .select('AVG(review.rating)', 'mean')
      .getRawOne<{ mean: string | null }>();

    if (raw?.mean != null) {
      this.cachedMean = Number(Number(raw.mean).toFixed(2));
    }
    // else: no reviews exist platform-wide yet — keep the neutral default.

    this.logger.log(`Platform mean rating (C) refreshed: ${this.cachedMean}`);
  }

  /** `C` in the Bayesian weighted-rating formula. */
  getMean(): number {
    return this.cachedMean;
  }
}
