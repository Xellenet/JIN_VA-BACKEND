import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Review } from './entities/review.entity';
import { CreateReviewDto } from './dto/create-review.dto';
import { Artisan } from '../artisans/entities/artisan.entity';
import { User } from '@users/entities/user.entity';

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    @InjectRepository(Review)
    private readonly reviewsRepository: Repository<Review>,
    @InjectRepository(Artisan)
    private readonly artisansRepository: Repository<Artisan>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  async create(createReviewDto: CreateReviewDto): Promise<Review> {
    const artisan = await this.artisansRepository.findOne({
      where: { id: createReviewDto.artisanId },
      relations: ['user'],
    });

    if (!artisan) {
      throw new NotFoundException(`Artisan with id ${createReviewDto.artisanId} not found.`);
    }

    let reviewerUser: User | undefined;
    if (createReviewDto.reviewerUserId) {
      const foundReviewer = await this.usersRepository.findOne({
        where: { id: createReviewDto.reviewerUserId },
      });

      if (!foundReviewer) {
        throw new NotFoundException(
          `Reviewer user with id ${createReviewDto.reviewerUserId} not found.`,
        );
      }

      reviewerUser = foundReviewer;
    }

    let reviewedUser: User;
    if (createReviewDto.reviewedUserId) {
      const foundReviewedUser = await this.usersRepository.findOne({
        where: { id: createReviewDto.reviewedUserId },
      });

      if (!foundReviewedUser) {
        throw new NotFoundException(
          `Reviewed user with id ${createReviewDto.reviewedUserId} not found.`,
        );
      }

      if (artisan.user?.id && artisan.user.id !== foundReviewedUser.id) {
        throw new BadRequestException(
          'reviewedUserId must match the artisan profile owner user id.',
        );
      }

      reviewedUser = foundReviewedUser;
    } else if (artisan.user) {
      reviewedUser = artisan.user;
    } else {
      throw new NotFoundException('Artisan owner user was not found for review mapping.');
    }

    const review = this.reviewsRepository.create({
      artisan,
      reviewerUser,
      reviewedUser,
      reviewerName: createReviewDto.reviewerName,
      rating: createReviewDto.rating,
      review: createReviewDto.review,
    });

    const savedReview = await this.reviewsRepository.save(review);
    await this.refreshArtisanRatings(artisan.id);

    this.logger.log(`Added review for artisan id: ${artisan.id}`);
    return this.findOne(savedReview.id);
  }

  async findAll(): Promise<Review[]> {
    return this.reviewsRepository.find({
      relations: ['artisan', 'reviewerUser', 'reviewedUser'],
      order: { id: 'DESC' },
    });
  }

  async findByArtisanId(artisanId: number): Promise<Review[]> {
    return this.reviewsRepository.find({
      where: { artisan: { id: artisanId } },
      relations: ['artisan', 'reviewerUser', 'reviewedUser'],
      order: { id: 'DESC' },
    });
  }

  async findByReviewedUserId(reviewedUserId: number): Promise<Review[]> {
    return this.reviewsRepository.find({
      where: { reviewedUser: { id: reviewedUserId } },
      relations: ['artisan', 'reviewerUser', 'reviewedUser'],
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number): Promise<Review> {
    const review = await this.reviewsRepository.findOne({
      where: { id },
      relations: ['artisan', 'reviewerUser', 'reviewedUser'],
    });

    if (!review) {
      throw new NotFoundException(`Review with id ${id} not found.`);
    }

    return review;
  }

  private async refreshArtisanRatings(artisanId: number): Promise<void> {
    const rawStats = await this.reviewsRepository
      .createQueryBuilder('review')
      .select('COALESCE(AVG(review.rating), 0)', 'averageRating')
      .addSelect('COUNT(review.id)', 'totalRatings')
      .where('review.artisan_id = :artisanId', { artisanId })
      .getRawOne<{ averageRating: string; totalRatings: string }>();

    const averageRating = rawStats?.averageRating ? Number(rawStats.averageRating) : 0;
    const totalRatings = rawStats?.totalRatings ? Number(rawStats.totalRatings) : 0;

    await this.artisansRepository.update(artisanId, {
      averageRating: Number(averageRating.toFixed(2)),
      totalRatings,
    });
  }
}
