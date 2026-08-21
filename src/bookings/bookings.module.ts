import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { Booking } from './entities/booking.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { ArtisanAvailability } from '../availability/entities/artisan-availability.entity';
import { AvailabilityModule } from '../availability/availability.module';
import { Job } from '@jobs/entities/job.entity';
import { JobStatusHistory } from '@jobs/entities/job-status-history.entity';
import { JobAttachment } from '@jobs/entities/job-attachment.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Booking,
      ArtisanProfile,
      ServiceEntity,
      ArtisanAvailability,
      Job,
      JobStatusHistory,
      JobAttachment,
    ]),
    AvailabilityModule,
  ],
  controllers: [BookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}
