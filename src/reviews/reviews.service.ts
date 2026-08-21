import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';
import { Review } from './entities/review.entity';
import { ReviewPhoto } from './entities/review-photo.entity';
import { ReviewModerationAction } from './entities/review-moderation-action.entity';
import { CreateReviewDto } from './dto/create-review.dto';
import { UpdateReviewDto } from './dto/update-review.dto';
import { CreateReviewReplyDto } from './dto/create-review-reply.dto';
import { FlagReviewDto } from './dto/flag-review.dto';
import { RemoveReviewDto } from './dto/remove-review.dto';
import { GetReviewsQueryDto } from './dto/get-reviews-query.dto';
import {
  AdminReviewsQueryDto,
  ModerationLogQueryDto,
} from './dto/admin-reviews-query.dto';
import { ReviewResponseDto } from './dto/review-response.dto';
import {
  AdminReviewResponseDto,
  ReviewFlagSummaryDto,
} from './dto/admin-review-response.dto';
import { ReviewModerationActionResponseDto } from './dto/review-moderation-action-response.dto';
import { PlatformRatingCacheService } from './platform-rating-cache.service';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { User } from '@users/entities/user.entity';
import { Job } from '@jobs/entities/job.entity';
import { ModerationAction, ReviewStatus, Status } from '@common/types/enums';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';
import { VARIABLES } from '@common/constants/variables.constants';
import { APP_EVENTS, ReviewReceivedPayload } from '@common/events/app.events';

const REVIEW_PHOTO_MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

type Pagination = {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};
type ReviewList = {
  message: string;
  data: ReviewResponseDto[];
  pagination: Pagination;
};
type ReviewItem = { message: string; data: ReviewResponseDto };
type AdminReviewList = {
  message: string;
  data: AdminReviewResponseDto[];
  pagination: Pagination;
};
type ModerationLogList = {
  message: string;
  data: ReviewModerationActionResponseDto[];
  pagination: Pagination;
};

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    @InjectRepository(Review)
    private readonly reviewsRepository: Repository<Review>,
    @InjectRepository(ReviewPhoto)
    private readonly reviewPhotosRepository: Repository<ReviewPhoto>,
    @InjectRepository(ReviewModerationAction)
    private readonly moderationActionsRepository: Repository<ReviewModerationAction>,
    @InjectRepository(ArtisanProfile)
    private readonly artisanProfileRepository: Repository<ArtisanProfile>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Job)
    private readonly jobsRepository: Repository<Job>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly platformRatingCache: PlatformRatingCacheService,
  ) {}

  // ─── Customer-facing writes ─────────────────────────────────────────────────

  /**
   * Submits a new review for an artisan on a completed job.
   *
   * Rules enforced:
   * - The job must exist and be in COMPLETED status.
   * - The caller must be the customer who posted the job.
   * - Only one review is allowed per job (service-level check here, plus a
   *   DB-level partial unique index on `job_id` closing the write race).
   * - The job must have an accepted artisan (always true for COMPLETED jobs).
   * - RP1: up to `REVIEW_MAX_PHOTOS` pre-uploaded photo URLs are persisted
   *   as `ReviewPhoto` rows.
   *
   * On success the artisan's aggregate rating (plain + Bayesian-weighted) is
   * recalculated.
   *
   * @param customerId - The authenticated customer's user ID (from JWT).
   * @param dto - Review data: jobId, rating, optional text, optional photoUrls.
   * @returns `{ message, data: ReviewResponseDto }`.
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

    const reviewer = await this.usersRepository.findOne({
      where: { id: customerId },
    });

    const review = this.reviewsRepository.create({
      job,
      artisanProfile,
      reviewerUser: reviewer ?? undefined,
      reviewedUser: job.acceptedArtisan,
      reviewerName: reviewer
        ? `${reviewer.firstname} ${reviewer.lastname}`
        : undefined,
      rating: dto.rating,
      review: dto.review,
    });

    const savedReview = await this.reviewsRepository.save(review);

    if (dto.photoUrls?.length) {
      const photos = dto.photoUrls
        .slice(0, VARIABLES.REVIEW_MAX_PHOTOS)
        .map((url) =>
          this.reviewPhotosRepository.create({
            reviewId: savedReview.id,
            url,
            fileType: this.guessMimeFromUrl(url),
          }),
        );
      await this.reviewPhotosRepository.save(photos);
    }

    await this.refreshArtisanRatings(artisanProfile.id);
    this.logger.log(
      `Review submitted for job ${dto.jobId} by customer ${customerId}`,
    );

    this.eventEmitter.emit(APP_EVENTS.REVIEW_RECEIVED, {
      artisanUserId: job.acceptedArtisan.id,
      jobTitle: job.title ?? `Job #${job.id}`,
      jobId: job.id,
      rating: dto.rating,
      reviewerName: reviewer
        ? `${reviewer.firstname} ${reviewer.lastname}`
        : 'A customer',
    } as ReviewReceivedPayload);

    const populated = await this.loadPopulated(savedReview.id);
    return {
      message: SUCCESS_MESSAGES.REVIEW.CREATED,
      data: this.toResponseDto(populated!),
    };
  }

  /**
   * RE1: edits the caller's own review within the 48-hour edit window.
   * Allowed even when the review is currently `FLAGGED` — flagging is not a
   * finding of guilt. Not allowed once a review is `REMOVED`, but that state
   * can never be observed here since AM3 hard-deletes the row (a removed
   * review simply 404s, same as any nonexistent id).
   *
   * @param userId - The authenticated caller's user ID.
   * @param id - The review ID to edit.
   * @param dto - At least one of `rating`/`review` must be provided.
   * @throws {BadRequestException} Neither `rating` nor `review` provided.
   * @throws {NotFoundException} Review does not exist (or was removed).
   * @throws {ForbiddenException} Caller is not the original reviewer, or the
   *   48-hour edit window (server clock) has passed.
   */
  async update(
    userId: number,
    id: number,
    dto: UpdateReviewDto,
  ): Promise<ReviewItem> {
    if (dto.rating === undefined && dto.review === undefined) {
      throw new BadRequestException(ERROR_MESSAGES.REVIEW.NO_FIELDS_TO_UPDATE);
    }

    const review = await this.reviewsRepository.findOne({
      where: { id },
      relations: ['reviewerUser', 'artisanProfile'],
    });
    if (!review) {
      throw new NotFoundException(ERROR_MESSAGES.REVIEW.NOT_FOUND(id));
    }

    if (!review.reviewerUser || review.reviewerUser.id !== userId) {
      throw new ForbiddenException(ERROR_MESSAGES.REVIEW.NOT_REVIEW_OWNER);
    }

    const hoursSinceCreated =
      (Date.now() - review.createdAt.getTime()) / (1000 * 60 * 60);
    if (hoursSinceCreated > VARIABLES.REVIEW_EDIT_WINDOW_HOURS) {
      throw new ForbiddenException(ERROR_MESSAGES.REVIEW.EDIT_WINDOW_EXPIRED);
    }

    if (dto.rating !== undefined) review.rating = dto.rating;
    if (dto.review !== undefined) review.review = dto.review;
    review.editedAt = new Date();

    await this.reviewsRepository.save(review);
    await this.refreshArtisanRatings(review.artisanProfile.id);
    this.logger.log(`Review ${id} edited by user ${userId}`);

    const populated = await this.loadPopulated(id);
    return {
      message: SUCCESS_MESSAGES.REVIEW.UPDATED,
      data: this.toResponseDto(populated!),
    };
  }

  /**
   * AR1: the reviewed artisan's one-time public reply. Rejects a second
   * attempt (one reply per review) and enforces that the caller is the
   * artisan the review is actually about.
   */
  async addReply(
    artisanUserId: number,
    id: number,
    dto: CreateReviewReplyDto,
  ): Promise<ReviewItem> {
    const review = await this.reviewsRepository.findOne({
      where: { id },
      relations: ['reviewedUser', 'artisanProfile'],
    });
    if (!review) {
      throw new NotFoundException(ERROR_MESSAGES.REVIEW.NOT_FOUND(id));
    }

    if (review.reviewedUser.id !== artisanUserId) {
      throw new ForbiddenException(ERROR_MESSAGES.REVIEW.NOT_REVIEWED_ARTISAN);
    }

    if (review.artisanReply) {
      throw new ConflictException(ERROR_MESSAGES.REVIEW.ALREADY_REPLIED);
    }

    review.artisanReply = dto.reply;
    review.artisanRepliedAt = new Date();
    await this.reviewsRepository.save(review);
    this.logger.log(`Artisan ${artisanUserId} replied to review ${id}`);

    const populated = await this.loadPopulated(id);
    return {
      message: SUCCESS_MESSAGES.REVIEW.REPLY_ADDED,
      data: this.toResponseDto(populated!),
    };
  }

  /**
   * FL1: any authenticated user may flag a review with a required reason.
   * Immediately hides the review from every public read except the original
   * reviewer's own view (enforced in the find* methods below, not here).
   * A `FLAGGED` review still counts toward rating aggregation, so no
   * recalculation is triggered by flagging.
   *
   * @throws {ConflictException} This exact user already flagged this review.
   */
  async flag(
    actor: User,
    id: number,
    dto: FlagReviewDto,
  ): Promise<{ message: string }> {
    const review = await this.reviewsRepository.findOne({
      where: { id },
      relations: ['reviewerUser', 'reviewedUser', 'artisanProfile'],
    });
    if (!review) {
      throw new NotFoundException(ERROR_MESSAGES.REVIEW.NOT_FOUND(id));
    }

    const alreadyFlaggedByActor =
      await this.moderationActionsRepository.findOne({
        where: {
          reviewId: id,
          actorId: actor.id,
          action: ModerationAction.FLAG,
        },
      });
    if (alreadyFlaggedByActor) {
      throw new ConflictException(ERROR_MESSAGES.REVIEW.ALREADY_FLAGGED_BY_YOU);
    }

    await this.moderationActionsRepository.save(
      this.moderationActionsRepository.create(
        this.buildModerationLogEntry(
          review,
          actor,
          ModerationAction.FLAG,
          dto.reason,
        ),
      ),
    );

    if (review.status === ReviewStatus.ACTIVE) {
      review.status = ReviewStatus.FLAGGED;
      await this.reviewsRepository.save(review);
    }

    this.logger.log(`Review ${id} flagged by user ${actor.id}`);
    return { message: SUCCESS_MESSAGES.REVIEW.FLAGGED };
  }

  // ─── Public reads ────────────────────────────────────────────────────────────

  /**
   * Returns a paginated list of all reviews, optionally filtered by minimum
   * rating. `FLAGGED` reviews are excluded unless `viewerId` matches the
   * original reviewer (FL1).
   *
   * @param query - Pagination and filter options.
   * @param viewerId - The authenticated caller's user id, if any (optional auth).
   */
  async findAll(
    query: GetReviewsQueryDto,
    viewerId?: number,
  ): Promise<ReviewList> {
    const qb = this.buildReviewsQb();
    this.applyVisibility(qb, viewerId);
    this.applyReviewFilters(qb, query);
    return this.paginate(qb, query);
  }

  /**
   * Returns a paginated list of reviews for a specific artisan profile.
   * Same FL1 visibility rule as {@link findAll}.
   */
  async findByArtisanProfileId(
    artisanProfileId: number,
    query: GetReviewsQueryDto,
    viewerId?: number,
  ): Promise<ReviewList> {
    const qb = this.buildReviewsQb();
    qb.andWhere('artisanProfile.id = :artisanProfileId', { artisanProfileId });
    this.applyVisibility(qb, viewerId);
    this.applyReviewFilters(qb, query);
    return this.paginate(qb, query);
  }

  /**
   * Returns a paginated list of reviews written about a specific user.
   * Same FL1 visibility rule as {@link findAll}.
   */
  async findByReviewedUserId(
    reviewedUserId: number,
    query: GetReviewsQueryDto,
    viewerId?: number,
  ): Promise<ReviewList> {
    const qb = this.buildReviewsQb();
    qb.andWhere('reviewedUser.id = :reviewedUserId', { reviewedUserId });
    this.applyVisibility(qb, viewerId);
    this.applyReviewFilters(qb, query);
    return this.paginate(qb, query);
  }

  /**
   * Returns a single review by its ID. A `FLAGGED` review resolves as 404
   * for anyone other than the original reviewer (FL1) — indistinguishable
   * from a nonexistent review to the caller, matching the ownership-check
   * convention used elsewhere in this API.
   */
  async findOne(id: number, viewerId?: number): Promise<ReviewItem> {
    const review = await this.loadPopulated(id);

    if (!review) {
      throw new NotFoundException(ERROR_MESSAGES.REVIEW.NOT_FOUND(id));
    }

    // `viewerId !== undefined` must be checked explicitly here: if the
    // original reviewer's account was later deleted, `review.reviewerUser`
    // is `undefined` too (SET NULL) — without this guard, an anonymous
    // caller (`viewerId` also `undefined`) would satisfy
    // `undefined === undefined` and be wrongly treated as the owner.
    const isOwnFlaggedReview =
      viewerId !== undefined &&
      review.status === ReviewStatus.FLAGGED &&
      review.reviewerUser?.id === viewerId;

    if (review.status === ReviewStatus.FLAGGED && !isOwnFlaggedReview) {
      throw new NotFoundException(ERROR_MESSAGES.REVIEW.NOT_FOUND(id));
    }

    return {
      message: SUCCESS_MESSAGES.REVIEW.RETRIEVED,
      data: this.toResponseDto(review),
    };
  }

  // ─── Admin moderation (AM2–AM5) ────────────────────────────────────────────────

  /** AM2: every status is visible here, unlike the public find* methods above. */
  async adminFindAll(query: AdminReviewsQueryDto): Promise<AdminReviewList> {
    const qb = this.buildReviewsQb();
    if (query.status) {
      qb.andWhere('review.status = :status', { status: query.status });
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [reviews, total] = await qb
      .orderBy('review.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    const flagsByReviewId = await this.loadFlagSummaries(
      reviews.map((r) => r.id),
    );

    const data = reviews.map((review) =>
      this.toAdminResponseDto(review, flagsByReviewId.get(review.id) ?? []),
    );

    return {
      message: SUCCESS_MESSAGES.REVIEW.ADMIN_LIST_RETRIEVED,
      data,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * AM3: permanently deletes a review (hard delete, not a status flip).
   * A `review_moderation_actions` row is written FIRST, inside the same
   * transaction as the delete, so the reason/actor/snapshot survive even
   * though the review itself does not. Rating aggregation is recalculated
   * immediately after, excluding the deleted review.
   */
  async adminRemove(
    admin: User,
    id: number,
    dto: RemoveReviewDto,
  ): Promise<{ message: string }> {
    const review = await this.loadForModerationOrFail(id);
    const artisanProfileId = review.artisanProfile.id;

    await this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(ReviewModerationAction)
        .save(
          manager
            .getRepository(ReviewModerationAction)
            .create(
              this.buildModerationLogEntry(
                review,
                admin,
                ModerationAction.REMOVE,
                dto.reason,
              ),
            ),
        );

      // `review_photos` rows cascade-delete via their FK's ON DELETE CASCADE.
      await manager.getRepository(Review).delete(review.id);
    });

    await this.refreshArtisanRatings(artisanProfileId);
    this.logger.log(`Review ${id} permanently removed by admin ${admin.id}`);

    return { message: SUCCESS_MESSAGES.REVIEW.REMOVED };
  }

  /**
   * AM4: restores a `FLAGGED` review back to `ACTIVE`. Not applicable to a
   * `REMOVED` review, which no longer exists to restore. No reason is
   * required (a low-stakes, single-click reversal of a flag), but the
   * action is still logged for the accountability trail.
   */
  async adminRestore(admin: User, id: number): Promise<{ message: string }> {
    const review = await this.loadForModerationOrFail(id);

    if (review.status !== ReviewStatus.FLAGGED) {
      throw new BadRequestException(ERROR_MESSAGES.REVIEW.NOT_FLAGGED);
    }

    await this.moderationActionsRepository.save(
      this.moderationActionsRepository.create(
        this.buildModerationLogEntry(
          review,
          admin,
          ModerationAction.RESTORE,
          null,
        ),
      ),
    );

    review.status = ReviewStatus.ACTIVE;
    await this.reviewsRepository.save(review);
    await this.refreshArtisanRatings(review.artisanProfile.id);
    this.logger.log(`Review ${id} restored by admin ${admin.id}`);

    return { message: SUCCESS_MESSAGES.REVIEW.RESTORED };
  }

  /** AM5: paginated, admin-only accountability trail — survives review deletion. */
  async getModerationLog(
    query: ModerationLogQueryDto,
  ): Promise<ModerationLogList> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [entries, total] =
      await this.moderationActionsRepository.findAndCount({
        order: { createdAt: 'DESC' },
        skip,
        take: limit,
      });

    return {
      message: SUCCESS_MESSAGES.REVIEW.MODERATION_LOG_RETRIEVED,
      data: plainToInstance(ReviewModerationActionResponseDto, entries, {
        excludeExtraneousValues: true,
      }),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private buildReviewsQb(): SelectQueryBuilder<Review> {
    return this.reviewsRepository
      .createQueryBuilder('review')
      .leftJoinAndSelect('review.artisanProfile', 'artisanProfile')
      .leftJoinAndSelect('review.reviewerUser', 'reviewerUser')
      .leftJoinAndSelect('review.reviewedUser', 'reviewedUser')
      .leftJoinAndSelect('review.job', 'job')
      .leftJoinAndSelect('review.photos', 'photos');
  }

  private applyReviewFilters(
    qb: SelectQueryBuilder<Review>,
    query: GetReviewsQueryDto,
  ): void {
    if (query.minRating !== undefined) {
      qb.andWhere('review.rating >= :minRating', {
        minRating: query.minRating,
      });
    }
  }

  /**
   * FL1: a `FLAGGED` review is excluded from every public-facing read
   * unless the caller is the original reviewer. `REMOVED` never needs an
   * explicit exclusion here — it's hard-deleted, so no such row can exist.
   */
  private applyVisibility(
    qb: SelectQueryBuilder<Review>,
    viewerId?: number,
  ): void {
    if (viewerId !== undefined) {
      qb.andWhere(
        '(review.status = :activeStatus OR (review.status = :flaggedStatus AND reviewerUser.id = :viewerId))',
        {
          activeStatus: ReviewStatus.ACTIVE,
          flaggedStatus: ReviewStatus.FLAGGED,
          viewerId,
        },
      );
    } else {
      qb.andWhere('review.status = :activeStatus', {
        activeStatus: ReviewStatus.ACTIVE,
      });
    }
  }

  private async paginate(
    qb: SelectQueryBuilder<Review>,
    query: { page?: number; limit?: number },
  ): Promise<ReviewList> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const [reviews, total] = await qb
      .orderBy('review.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return {
      message: SUCCESS_MESSAGES.REVIEW.ALL_RETRIEVED,
      data: reviews.map((review) => this.toResponseDto(review)),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * RA1/RA2: recalculates both the plain average (`R`) and the Bayesian
   * weighted rating (`WR`) for an artisan. Counts every persisted review
   * regardless of status (`ACTIVE` and `FLAGGED` both count — "innocent
   * until moderated"; a `REMOVED` review is hard-deleted, so it can never
   * appear in this query in the first place). Must be reachable from
   * create/edit/remove/restore — every one of those call sites invokes this.
   */
  private async refreshArtisanRatings(artisanProfileId: number): Promise<void> {
    const rawStats = await this.reviewsRepository
      .createQueryBuilder('review')
      .select('COALESCE(AVG(review.rating), 0)', 'averageRating')
      .addSelect('COUNT(review.id)', 'totalReviews')
      .where('review.artisan_profile_id = :artisanProfileId', {
        artisanProfileId,
      })
      .getRawOne<{ averageRating: string; totalReviews: string }>();

    const averageRating = rawStats?.averageRating
      ? Number(rawStats.averageRating)
      : 0;
    const totalReviews = rawStats?.totalReviews
      ? Number(rawStats.totalReviews)
      : 0;

    const m = VARIABLES.RATING_BAYESIAN_MIN_VOTES;
    const platformMean = this.platformRatingCache.getMean();
    const weightedRating =
      (totalReviews / (totalReviews + m)) * averageRating +
      (m / (totalReviews + m)) * platformMean;

    await this.artisanProfileRepository.update(artisanProfileId, {
      averageRating: Number(averageRating.toFixed(2)),
      totalReviews,
      weightedRating: Number(weightedRating.toFixed(2)),
    });
  }

  private async loadPopulated(id: number): Promise<Review | null> {
    return this.reviewsRepository.findOne({
      where: { id },
      relations: [
        'artisanProfile',
        'reviewerUser',
        'reviewedUser',
        'job',
        'photos',
      ],
    });
  }

  private async loadForModerationOrFail(id: number): Promise<Review> {
    const review = await this.reviewsRepository.findOne({
      where: { id },
      relations: ['artisanProfile', 'reviewerUser', 'reviewedUser', 'photos'],
    });
    if (!review) {
      throw new NotFoundException(ERROR_MESSAGES.REVIEW.NOT_FOUND(id));
    }
    return review;
  }

  /**
   * AM5: builds the append-only log row for a flag/remove/restore action,
   * snapshotting reviewer/artisan/rating/text-excerpt from the review as it
   * exists right now — called BEFORE any delete happens (AM3).
   */
  private buildModerationLogEntry(
    review: Review,
    actor: User,
    action: ModerationAction,
    reason: string | null,
  ): Partial<ReviewModerationAction> {
    const artisanName =
      review.artisanProfile?.businessName ||
      (review.reviewedUser
        ? `${review.reviewedUser.firstname} ${review.reviewedUser.lastname}`
        : undefined);

    return {
      reviewId: review.id,
      action,
      reason: reason ?? undefined,
      actorId: actor.id,
      actorName: `${actor.firstname} ${actor.lastname}`,
      actorRole: actor.role,
      reviewerId: review.reviewerUser?.id,
      reviewerName:
        review.reviewerName ??
        (review.reviewerUser
          ? `${review.reviewerUser.firstname} ${review.reviewerUser.lastname}`
          : undefined),
      artisanProfileId: review.artisanProfile?.id,
      artisanName,
      rating: review.rating,
      reviewExcerpt: review.review
        ? review.review.slice(
            0,
            VARIABLES.REVIEW_MODERATION_SNAPSHOT_EXCERPT_LENGTH,
          )
        : undefined,
    };
  }

  /** AM2: groups FLAG actions by review id, oldest first, for the admin table/dialog. */
  private async loadFlagSummaries(
    reviewIds: number[],
  ): Promise<Map<number, ReviewFlagSummaryDto[]>> {
    const map = new Map<number, ReviewFlagSummaryDto[]>();
    if (reviewIds.length === 0) return map;

    const flagActions = await this.moderationActionsRepository.find({
      where: { reviewId: In(reviewIds), action: ModerationAction.FLAG },
      order: { createdAt: 'ASC' },
    });

    for (const action of flagActions) {
      const list = map.get(action.reviewId) ?? [];
      list.push({
        reason: action.reason ?? '',
        actorName: action.actorName,
        createdAt: action.createdAt,
      });
      map.set(action.reviewId, list);
    }
    return map;
  }

  /** VB1: always true — write-time validation already guarantees a completed job. */
  private toResponseDto(review: Review): ReviewResponseDto {
    const dto = plainToInstance(ReviewResponseDto, review, {
      excludeExtraneousValues: true,
    });
    dto.verifiedBooking = true;
    return dto;
  }

  private toAdminResponseDto(
    review: Review,
    flags: ReviewFlagSummaryDto[],
  ): AdminReviewResponseDto {
    const dto = plainToInstance(AdminReviewResponseDto, review, {
      excludeExtraneousValues: true,
    });
    dto.verifiedBooking = true;
    dto.flags = flags;
    return dto;
  }

  /**
   * RP1: infers a display MIME type from an already-uploaded, already
   * MIME-sniffed photo URL's extension — mirrors `JobsService`'s identical
   * `guessMimeFromUrl` helper for job attachments. Not a security control
   * (the real content-type check already happened at upload time in
   * `UploadsService.uploadReviewPhoto`); this is metadata only.
   */
  private guessMimeFromUrl(url: string): string {
    const ext = url.slice(url.lastIndexOf('.')).toLowerCase();
    return REVIEW_PHOTO_MIME_BY_EXT[ext] ?? 'image/jpeg';
  }
}
