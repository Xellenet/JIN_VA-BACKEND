import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { Review } from './entities/review.entity';
import { Artisan } from '../artisans/entities/artisan.entity';
import { User } from '@users/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Review, Artisan, User])],
  controllers: [ReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
