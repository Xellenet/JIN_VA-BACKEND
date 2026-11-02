import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { PlatformRatingCacheService } from './platform-rating-cache.service';
import { Review } from './entities/review.entity';
import { ReviewPhoto } from './entities/review-photo.entity';
import { ReviewModerationAction } from './entities/review-moderation-action.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { User } from '@users/entities/user.entity';
import { Job } from '@jobs/entities/job.entity';
import { ThrottlingModule } from '@common/throttling/throttling.module';
import { ArtisanInsightsThrottlerGuard } from '@common/throttling/artisan-throttler.guards';
import { ReviewSummaryService } from './review-summary.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Review,
      ReviewPhoto,
      ReviewModerationAction,
      ArtisanProfile,
      User,
      Job,
    ]),
    // Artisan fixes: B7 `GET /reviews/me/summary` is rate-limited per user.
    ThrottlingModule,
  ],
  controllers: [ReviewsController],
  providers: [
    ReviewsService,
    PlatformRatingCacheService,
    ReviewSummaryService,
    ArtisanInsightsThrottlerGuard,
  ],
  exports: [ReviewsService],
})
export class ReviewsModule {}
