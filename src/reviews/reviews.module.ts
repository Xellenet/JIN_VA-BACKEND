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
  ],
  controllers: [ReviewsController],
  providers: [ReviewsService, PlatformRatingCacheService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
