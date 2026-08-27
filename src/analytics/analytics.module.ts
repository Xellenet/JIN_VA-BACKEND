import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { Job } from '@jobs/entities/job.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Payment } from '../payments/entities/payment.entity';
import { Review } from '../reviews/entities/review.entity';
import { DisputesModule } from '../disputes/disputes.module';
import { AnalyticsController } from './analytics.controller';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminAnalyticsService } from './admin-analytics.service';
import { ArtisanAnalyticsService } from './artisan-analytics.service';
import { PlatformAnalyticsCacheService } from './platform-analytics-cache.service';

/**
 * AN1: PRD §7's `AnalyticsModule` ("artisan stats, admin platform stats"),
 * which did not exist in any form — no module, no file, no import — while both
 * analytics screens rendered module-level literals.
 *
 * Two controllers because the PRD names two different path prefixes
 * (`/analytics/artisan`, admin-scoped `/admin/analytics`) and Nest binds one
 * prefix per controller.
 *
 * Read-only: this module owns no entities of its own and writes nothing. It
 * reads the tables the rest of the platform already maintains, which is why no
 * migration accompanies it and why no snapshot/rollup table was introduced.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      ArtisanProfile,
      Job,
      Booking,
      Payment,
      Review,
    ]),
    // DR6/AP3: reuses DisputesService.getResolutionMetrics rather than
    // re-deriving the dispute SLA aggregate a second time.
    DisputesModule,
  ],
  controllers: [AnalyticsController, AdminAnalyticsController],
  providers: [
    AdminAnalyticsService,
    ArtisanAnalyticsService,
    PlatformAnalyticsCacheService,
  ],
})
export class AnalyticsModule {}
