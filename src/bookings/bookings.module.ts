import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { Booking } from './entities/booking.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { ArtisanAvailability } from '../availability/entities/artisan-availability.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Booking, ArtisanProfile, ArtisanAvailability])],
  controllers: [BookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}
