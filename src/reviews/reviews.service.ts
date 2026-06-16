import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Review } from './entities/review.entity';
import { CreateReviewDto } from './dto/create-review.dto';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { User } from '@users/entities/user.entity';

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    @InjectRepository(Review)
    private readonly reviewsRepository: Repository<Review>,
    @InjectRepository(ArtisanProfile)
    private readonly artisanProfileRepository: Repository<ArtisanProfile>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  async create(createReviewDto: CreateReviewDto): Promise<Review> {
    const artisanProfile = await this.artisanProfileRepository.findOne({
      where: { id: createReviewDto.artisanProfileId },
      relations: ['user'],
    });

    if (!artisanProfile) {
      throw new NotFoundException(
        `Artisan profile with id ${createReviewDto.artisanProfileId} not found.`,
      );
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

      if (artisanProfile.user?.id && artisanProfile.user.id !== foundReviewedUser.id) {
        throw new BadRequestException(
          'reviewedUserId must match the artisan profile owner user id.',
        );
      }

      reviewedUser = foundReviewedUser;
    } else if (artisanProfile.user) {
      reviewedUser = artisanProfile.user;
    } else {
      throw new NotFoundException('Artisan profile owner user was not found for review mapping.');
    }

    const review = this.reviewsRepository.create({
      artisanProfile,
      reviewerUser,
      reviewedUser,
      reviewerName: createReviewDto.reviewerName,
      rating: createReviewDto.rating,
      review: createReviewDto.review,
    });

    const savedReview = await this.reviewsRepository.save(review);
    await this.refreshArtisanRatings(artisanProfile.id);

    this.logger.log(`Added review for artisan profile id: ${artisanProfile.id}`);
    return this.findOne(savedReview.id);
  }

  async findAll(): Promise<Review[]> {
    return this.reviewsRepository.find({
      relations: ['artisanProfile', 'reviewerUser', 'reviewedUser'],
      order: { id: 'DESC' },
    });
  }

  async findByArtisanProfileId(artisanProfileId: number): Promise<Review[]> {
    return this.reviewsRepository.find({
      where: { artisanProfile: { id: artisanProfileId } },
      relations: ['artisanProfile', 'reviewerUser', 'reviewedUser'],
      order: { id: 'DESC' },
    });
  }

  async findByReviewedUserId(reviewedUserId: number): Promise<Review[]> {
    return this.reviewsRepository.find({
      where: { reviewedUser: { id: reviewedUserId } },
      relations: ['artisanProfile', 'reviewerUser', 'reviewedUser'],
      order: { id: 'DESC' },
    });
  }

  async findOne(id: number): Promise<Review> {
    const review = await this.reviewsRepository.findOne({
      where: { id },
      relations: ['artisanProfile', 'reviewerUser', 'reviewedUser'],
    });

    if (!review) {
      throw new NotFoundException(`Review with id ${id} not found.`);
    }

    return review;
  }

  private async refreshArtisanRatings(artisanProfileId: number): Promise<void> {
    const rawStats = await this.reviewsRepository
      .createQueryBuilder('review')
      .select('COALESCE(AVG(review.rating), 0)', 'averageRating')
      .addSelect('COUNT(review.id)', 'totalReviews')
      .where('review.artisan_profile_id = :artisanProfileId', { artisanProfileId })
      .getRawOne<{ averageRating: string; totalReviews: string }>();

    const averageRating = rawStats?.averageRating ? Number(rawStats.averageRating) : 0;
    const totalReviews = rawStats?.totalReviews ? Number(rawStats.totalReviews) : 0;

    await this.artisanProfileRepository.update(artisanProfileId, {
      averageRating: Number(averageRating.toFixed(2)),
      totalReviews,
    });
  }
}
