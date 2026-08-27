import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { Job } from '@jobs/entities/job.entity';
import { JobApplication } from '@jobs/entities/job-application.entity';
import { ArtisanVerification } from '../verification/entities/artisan-verification.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Dispute } from '../disputes/entities/dispute.entity';
import { JobsModule } from '@jobs/jobs.module';
import { VerificationModule } from '../verification/verification.module';
import { DisputesModule } from '../disputes/disputes.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      ArtisanProfile,
      Job,
      JobApplication,
      ArtisanVerification,
      Booking,
      // AT6: disputes are one of the three entity types the cross-entity
      // admin search covers.
      Dispute,
    ]),
    JobsModule,
    VerificationModule,
    DisputesModule,
    PortfolioModule,
    ReviewsModule,
    // AT9: reads the platform fee percentage the payments service applies.
    PaymentsModule,
    // AT5: ban/unban and suspend/activate write audit rows, and the log's read
    // endpoint lives on AdminController.
    AdminAuditModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
