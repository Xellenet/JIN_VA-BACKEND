import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Payment } from '../payments/entities/payment.entity';
import { Job } from '@jobs/entities/job.entity';
import { JobApplication } from '@jobs/entities/job-application.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { Dispute } from '../disputes/entities/dispute.entity';
import { ThrottlingModule } from '@common/throttling/throttling.module';
import { ArtisanInsightsThrottlerGuard } from '@common/throttling/artisan-throttler.guards';
import { ArtisanOverviewController } from './artisan-overview.controller';
import { ArtisanOverviewService } from './artisan-overview.service';

/**
 * Artisan fixes: the artisan Overview (B1). Read-only; it owns no tables.
 * Registered through `AnalyticsModule`, so `AppModule` is not edited.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Payment,
      Job,
      JobApplication,
      Booking,
      ArtisanProfile,
      Dispute,
    ]),
    ThrottlingModule,
  ],
  controllers: [ArtisanOverviewController],
  providers: [ArtisanOverviewService, ArtisanInsightsThrottlerGuard],
})
export class ArtisanInsightsModule {}
