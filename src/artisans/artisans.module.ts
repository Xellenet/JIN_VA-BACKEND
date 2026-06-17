import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtisansController } from './artisans.controller';
import { ArtisansService } from './artisans.service';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { User } from '@users/entities/user.entity';
import { ServiceEntity } from '@services/entities/service.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ArtisanProfile, User, ServiceEntity])],
  controllers: [ArtisansController],
  providers: [ArtisansService],
  exports: [ArtisansService],
})
export class ArtisansModule {}
