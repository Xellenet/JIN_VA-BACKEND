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
import { JobsModule } from '@jobs/jobs.module';
import { VerificationModule } from '../verification/verification.module';
import { DisputesModule } from '../disputes/disputes.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, ArtisanProfile, Job, JobApplication, ArtisanVerification, Booking]),
    JobsModule,
    VerificationModule,
    DisputesModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
