import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtisanAvailability } from './entities/artisan-availability.entity';
import { BlockedSlot } from './entities/blocked-slot.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ArtisanAvailability,
      BlockedSlot,
      ArtisanProfile,
      Booking,
    ]),
  ],
  controllers: [AvailabilityController],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
