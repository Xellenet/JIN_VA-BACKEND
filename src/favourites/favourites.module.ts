import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FavouritesController } from './favourites.controller';
import { FavouritesService } from './favourites.service';
import { Favourite } from './entities/favourite.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { Job } from '@jobs/entities/job.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Favourite, ArtisanProfile, Job])],
  controllers: [FavouritesController],
  providers: [FavouritesService],
})
export class FavouritesModule {}
