import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { Review } from './entities/review.entity';
import { CreateReviewDto } from './dto/create-review.dto';
import { GetReviewsQueryDto } from './dto/get-reviews-query.dto';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { User } from '@users/entities/user.entity';
import { Job } from '@jobs/entities/job.entity';
import { Status } from '@common/types/enums';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';

type Pagination = { total: number; page: number; limit: number; totalPages: number };
type ReviewList = { message: string; data: Review[]; pagination: Pagination };
type ReviewItem = { message: string; data: Review };

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
    @InjectRepository(Job)
    private readonly jobsRepository: Repository<Job>,
  ) {}

  /**
   * Submits a new review for an artisan on a completed job.
   *
   * Rules enforced:
   * - The job must exist and be in COMPLETED status.
   * - The caller must be the customer who posted the job.
   * - Only one review is allowed per job.
   * - The job must have an accepted artisan (always true for COMPLETED jobs).
   *
   * On success the artisan's aggregate rating is recalculated.
   *
   * @param customerId - The authenticated customer's user ID (from JWT).
   * @param dto - Review data: jobId, rating, optional text.
   * @returns `{ message, data: Review }` with all relations populated.
   */
  async create(customerId: number, dto: CreateReviewDto): Promise<ReviewItem> {
    const job = await this.jobsRepository.findOne({
      where: { id: dto.jobId },
      relations: ['customer', 'acceptedArtisan'],
    });

    if (!job) {
      throw new NotFoundException(ERROR_MESSAGES.REVIEW.JOB_NOT_FOUND);
    }

    if (job.status !== Status.COMPLETED) {
      throw new BadRequestException(ERROR_MESSAGES.REVIEW.JOB_NOT_COMPLETED);
    }

    if (job.customer.id !== customerId) {
      throw new ForbiddenException(ERROR_MESSAGES.REVIEW.NOT_JOB_CUSTOMER);
    }

    if (!job.acceptedArtisan) {
      throw new BadRequestException(ERROR_MESSAGES.REVIEW.JOB_NO_ARTISAN);
    }

    const existing = await this.reviewsRepository.findOne({
      where: { job: { id: dto.jobId } },
    });
    if (existing) {
      throw new ConflictException(ERROR_MESSAGES.REVIEW.DUPLICATE);
    }

    const artisanProfile = await this.artisanProfileRepository.findOne({
      where: { user: { id: job.acceptedArtisan.id } },
    });
    if (!artisanProfile) {
      throw new NotFoundException('Artisan profile not found.');
    }

    const reviewer = await this.usersRepository.findOne({ where: { id: customerId } });

    const review = this.reviewsRepository.create({
      job,
      artisanProfile,
      reviewerUser: reviewer ?? undefined,
      reviewedUser: job.acceptedArtisan,
      reviewerName: reviewer ? `${reviewer.firstname} ${reviewer.lastname}` : undefined,
      rating: dto.rating,
      review: dto.review,
    });

    const savedReview = await this.reviewsRepository.save(review);
    await this.refreshArtisanRatings(artisanProfile.id);
    this.logger.log(`Review submitted for job ${dto.jobId} by customer ${customerId}`);

    const populated = await this.reviewsRepository.findOne({
      where: { id: savedReview.id },
      relations: ['artisanProfile', 'reviewerUser', 'reviewedUser', 'job'],
    });

    return { message: SUCCESS_MESSAGES.REVIEW.CREATED, data: populated! };
  }

  /**
   * Returns a paginated list of all reviews, optionally filtered by minimum rating.
   *
   * @param query - Pagination and filter options.
   * @returns `{ message, data, pagination }`.
   */
  async findAll(query: GetReviewsQueryDto): Promise<ReviewList> {
    const qb = this.buildReviewsQb();
    this.applyReviewFilters(qb, query);
    return this.paginate(qb, query);
  }

  /**
   * Returns a paginated list of reviews for a specific artisan profile.
   *
   * @param artisanProfileId - The artisan profile ID to filter by.
   * @param query - Pagination and filter options.
   * @returns `{ message, data, pagination }`.
   */
  async findByArtisanProfileId(
    artisanProfileId: number,
    query: GetReviewsQueryDto,
  ): Promise<ReviewList> {
    const qb = this.buildReviewsQb();
    qb.andWhere('artisanProfile.id = :artisanProfileId', { artisanProfileId });
    this.applyReviewFilters(qb, query);
    return this.paginate(qb, query);
  }

  /**
   * Returns a paginated list of reviews written about a specific user.
   *
   * @param reviewedUserId - The ID of the user who received the reviews.
   * @param query - Pagination and filter options.
   * @returns `{ message, data, pagination }`.
   */
  async findByReviewedUserId(
    reviewedUserId: number,
    query: GetReviewsQueryDto,
  ): Promise<ReviewList> {
    const qb = this.buildReviewsQb();
    qb.andWhere('reviewedUser.id = :reviewedUserId', { reviewedUserId });
    this.applyReviewFilters(qb, query);
    return this.paginate(qb, query);
  }

  /**
   * Returns a single review by its ID.
   *
   * @param id - The review ID to look up.
   * @returns `{ message, data: Review }` with all relations populated.
   * @throws {NotFoundException} When no review with the given ID exists.
   */
  async findOne(id: number): Promise<ReviewItem> {
    const review = await this.reviewsRepository.findOne({
      where: { id },
      relations: ['artisanProfile', 'reviewerUser', 'reviewedUser', 'job'],
    });

    if (!review) {
      throw new NotFoundException(`Review with id ${id} not found.`);
    }

    return { message: SUCCESS_MESSAGES.REVIEW.RETRIEVED, data: review };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private buildReviewsQb(): SelectQueryBuilder<Review> {
    return this.reviewsRepository
      .createQueryBuilder('review')
      .leftJoinAndSelect('review.artisanProfile', 'artisanProfile')
      .leftJoinAndSelect('review.reviewerUser', 'reviewerUser')
      .leftJoinAndSelect('review.reviewedUser', 'reviewedUser')
      .leftJoinAndSelect('review.job', 'job');
  }

  private applyReviewFilters(
    qb: SelectQueryBuilder<Review>,
    query: GetReviewsQueryDto,
  ): void {
    if (query.minRating !== undefined) {
      qb.andWhere('review.rating >= :minRating', { minRating: query.minRating });
    }
  }

  private async paginate(
    qb: SelectQueryBuilder<Review>,
    query: GetReviewsQueryDto,
  ): Promise<ReviewList> {
    const page  = query.page  ?? 1;
    const limit = query.limit ?? 10;
    const skip  = (page - 1) * limit;

    const [reviews, total] = await qb
      .orderBy('review.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return {
      message: SUCCESS_MESSAGES.REVIEW.ALL_RETRIEVED,
      data: reviews,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  private async refreshArtisanRatings(artisanProfileId: number): Promise<void> {
    const rawStats = await this.reviewsRepository
      .createQueryBuilder('review')
      .select('COALESCE(AVG(review.rating), 0)', 'averageRating')
      .addSelect('COUNT(review.id)', 'totalReviews')
      .where('review.artisan_profile_id = :artisanProfileId', { artisanProfileId })
      .getRawOne<{ averageRating: string; totalReviews: string }>();

    const averageRating = rawStats?.averageRating ? Number(rawStats.averageRating) : 0;
    const totalReviews  = rawStats?.totalReviews  ? Number(rawStats.totalReviews)  : 0;

    await this.artisanProfileRepository.update(artisanProfileId, {
      averageRating: Number(averageRating.toFixed(2)),
      totalReviews,
    });
  }
}
