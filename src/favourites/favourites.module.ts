import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FavouritesController } from './favourites.controller';
import { FavouritesService } from './favourites.service';
import { Favourite } from './entities/favourite.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Favourite, ArtisanProfile])],
  controllers: [FavouritesController],
  providers: [FavouritesService],
})
export class FavouritesModule {}
