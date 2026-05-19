import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtisansController } from './artisans.controller';
import { ArtisansService } from './artisans.service';
import { Artisan } from './entities/artisan.entity';
import { ArtisanPortfolioImage } from './entities/artisan-portfolio-image.entity';
import { User } from '@users/entities/user.entity';
import { Address } from '@users/entities/address.entity';
import { ServiceEntity } from '../services/entities/service.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Artisan, ArtisanPortfolioImage, User, Address, ServiceEntity]),
  ],
  controllers: [ArtisansController],
  providers: [ArtisansService],
  exports: [ArtisansService],
})
export class ArtisansModule {}
