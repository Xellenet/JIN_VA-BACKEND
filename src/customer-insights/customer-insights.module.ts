import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Payment } from '../payments/entities/payment.entity';
import { Job } from '@jobs/entities/job.entity';
import { JobApplication } from '@jobs/entities/job-application.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Message } from '@messages/entities/message.entity';
import { Conversation } from '@messages/entities/conversation.entity';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { ThrottlingModule } from '@common/throttling/throttling.module';
import { CustomerAnalyticsThrottlerGuard } from '@common/throttling/customer-throttler.guards';
import { CustomerOverviewController } from './customer-overview.controller';
import { CustomerOverviewService } from './customer-overview.service';
import { CustomerAnalyticsController } from './customer-analytics.controller';
import { CustomerAnalyticsService } from './customer-analytics.service';
import { SpendService } from './spend.util';

/**
 * Customer experience v2: the customer's Overview rail (B6) and Spending
 * report (B2). Read-only; it owns no tables. Registered through
 * `AnalyticsModule`, so `AppModule` is not edited.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Payment,
      Job,
      JobApplication,
      Booking,
      Message,
      Conversation,
      User,
      ArtisanProfile,
      ServiceEntity,
    ]),
    ThrottlingModule,
  ],
  controllers: [CustomerOverviewController, CustomerAnalyticsController],
  providers: [
    CustomerOverviewService,
    CustomerAnalyticsService,
    SpendService,
    CustomerAnalyticsThrottlerGuard,
  ],
  exports: [SpendService],
})
export class CustomerInsightsModule {}
