import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { Review } from './entities/review.entity';
import { ReviewPhoto } from './entities/review-photo.entity';
import { ReviewModerationAction } from './entities/review-moderation-action.entity';
import { PlatformRatingCacheService } from './platform-rating-cache.service';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { User } from '@users/entities/user.entity';
import { Job } from '@jobs/entities/job.entity';
import { ModerationAction, ReviewStatus, Role } from '@common/types/enums';
import { VARIABLES } from '@common/constants/variables.constants';

/** Minimal chainable query-builder stub covering every method this service calls. */
function mockQueryBuilder(overrides: Record<string, unknown> = {}) {
  const qb: Record<string, jest.Mock> = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    getRawOne: jest.fn().mockResolvedValue(undefined),
    getRawMany: jest.fn().mockResolvedValue([]),
    getMany: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
  return qb;
}

describe('ReviewsService', () => {
  let service: ReviewsService;

  const mockReviewsRepo = {
    findOne: jest.fn(),
    create: jest.fn((data: Record<string, unknown>) => data),
    save: jest.fn((data: Record<string, unknown>) => Promise.resolve(data)),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const mockReviewPhotosRepo = {
    create: jest.fn((data: Record<string, unknown>) => data),
    save: jest.fn(),
  };
  const mockModerationActionsRepo = {
    create: jest.fn((data: Record<string, unknown>) => data),
    save: jest.fn((data: Record<string, unknown>) => Promise.resolve(data)),
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  const mockArtisanProfileRepo = {
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const mockUsersRepo = { findOne: jest.fn() };
  const mockJobsRepo = { findOne: jest.fn() };
  const mockEventEmitter = { emit: jest.fn() };
  const mockPlatformRatingCache = { getMean: jest.fn().mockReturnValue(4) };

  const transactionalManager = {
    getRepository: jest.fn().mockImplementation((entity: unknown) => {
      if (entity === ReviewModerationAction) return mockModerationActionsRepo;
      if (entity === Review) return mockReviewsRepo;
      return mockReviewsRepo;
    }),
  };
  const mockDataSource = {
    transaction: jest.fn(async (cb: (manager: unknown) => Promise<void>) =>
      cb(transactionalManager),
    ),
  };

  const artisanProfile = {
    id: 5,
    businessName: 'Kofi Home Services',
  } as ArtisanProfile;
  const reviewer = {
    id: 10,
    firstname: 'Ama',
    lastname: 'Owusu',
    role: Role.CUSTOMER,
  } as User;
  const artisanUser = {
    id: 20,
    firstname: 'Kofi',
    lastname: 'Mensah',
    role: Role.ARTISAN,
  } as User;
  const admin = {
    id: 99,
    firstname: 'Admin',
    lastname: 'User',
    role: Role.ADMIN,
  } as User;

  function baseReview(overrides: Partial<Review> = {}): Review {
    return {
      id: 1,
      rating: 4,
      review: 'Great work, very professional.',
      reviewerName: 'Ama Owusu',
      status: ReviewStatus.ACTIVE,
      artisanReply: undefined,
      artisanRepliedAt: undefined,
      editedAt: undefined,
      photos: [],
      reviewerUser: reviewer,
      reviewedUser: artisanUser,
      artisanProfile,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as Review;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPlatformRatingCache.getMean.mockReturnValue(4);
    mockReviewsRepo.createQueryBuilder.mockReturnValue(
      mockQueryBuilder({
        getRawOne: jest
          .fn()
          .mockResolvedValue({ averageRating: '4.50', totalReviews: '2' }),
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: getRepositoryToken(Review), useValue: mockReviewsRepo },
        {
          provide: getRepositoryToken(ReviewPhoto),
          useValue: mockReviewPhotosRepo,
        },
        {
          provide: getRepositoryToken(ReviewModerationAction),
          useValue: mockModerationActionsRepo,
        },
        {
          provide: getRepositoryToken(ArtisanProfile),
          useValue: mockArtisanProfileRepo,
        },
        { provide: getRepositoryToken(User), useValue: mockUsersRepo },
        { provide: getRepositoryToken(Job), useValue: mockJobsRepo },
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        {
          provide: PlatformRatingCacheService,
          useValue: mockPlatformRatingCache,
        },
      ],
    }).compile();

    service = module.get(ReviewsService);
  });

  describe('update (RE1)', () => {
    it('rejects when neither rating nor review text is provided', async () => {
      await expect(service.update(reviewer.id, 1, {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a caller who is not the original reviewer', async () => {
      mockReviewsRepo.findOne.mockResolvedValueOnce(baseReview());
      await expect(service.update(999, 1, { rating: 3 })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects an edit after the 48h window has passed', async () => {
      const stale = baseReview({
        createdAt: new Date(
          Date.now() -
            (VARIABLES.REVIEW_EDIT_WINDOW_HOURS + 1) * 60 * 60 * 1000,
        ),
      });
      mockReviewsRepo.findOne.mockResolvedValueOnce(stale);
      await expect(
        service.update(reviewer.id, 1, { rating: 3 }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows editing a FLAGGED review within the window, and recalculates ratings', async () => {
      const flagged = baseReview({ status: ReviewStatus.FLAGGED });
      mockReviewsRepo.findOne
        .mockResolvedValueOnce(flagged) // ownership/window lookup
        .mockResolvedValueOnce(flagged); // loadPopulated after save

      const result = await service.update(reviewer.id, 1, {
        rating: 5,
        review: 'Updated review text here.',
      });

      expect(flagged.editedAt).toBeInstanceOf(Date);
      expect(flagged.rating).toBe(5);
      expect(mockReviewsRepo.save).toHaveBeenCalled();
      // Mocked `refreshArtisanRatings` stats (averageRating: '4.50', totalReviews: '2')
      // come from the beforeEach default query-builder mock, independent of the
      // in-memory `dto.rating` just applied — asserted as a concrete value here
      // rather than `expect.any(Number)` nested inside `objectContaining`, which
      // trips `@typescript-eslint/no-unsafe-assignment` against this repo's lint config.
      expect(mockArtisanProfileRepo.update).toHaveBeenCalledWith(
        artisanProfile.id,
        expect.objectContaining({ averageRating: 4.5, totalReviews: 2 }),
      );
      expect(result.data.status).toBe(ReviewStatus.FLAGGED);
    });

    it('404s when the review does not exist (covers the "removed reviews cannot be edited" case)', async () => {
      mockReviewsRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.update(reviewer.id, 999, { rating: 3 }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('addReply (AR1)', () => {
    it('rejects an artisan who is not the reviewed artisan', async () => {
      mockReviewsRepo.findOne.mockResolvedValueOnce(baseReview());
      await expect(
        service.addReply(12345, 1, { reply: 'Thanks!' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects a second reply attempt', async () => {
      mockReviewsRepo.findOne.mockResolvedValueOnce(
        baseReview({ artisanReply: 'Already replied once.' }),
      );
      await expect(
        service.addReply(artisanUser.id, 1, { reply: 'Second attempt' }),
      ).rejects.toThrow(ConflictException);
    });

    it('persists the reply for the correct artisan', async () => {
      const review = baseReview();
      mockReviewsRepo.findOne
        .mockResolvedValueOnce(review)
        .mockResolvedValueOnce(review);

      await service.addReply(artisanUser.id, 1, {
        reply: 'Thanks for the feedback!',
      });

      expect(review.artisanReply).toBe('Thanks for the feedback!');
      expect(review.artisanRepliedAt).toBeInstanceOf(Date);
    });
  });

  describe('flag (FL1)', () => {
    it('rejects a duplicate flag from the same user', async () => {
      mockReviewsRepo.findOne.mockResolvedValueOnce(baseReview());
      mockModerationActionsRepo.findOne.mockResolvedValueOnce({ id: 1 });

      await expect(
        service.flag(reviewer, 1, { reason: 'Looks fake to me.' }),
      ).rejects.toThrow(ConflictException);
    });

    it('logs the action and sets status to FLAGGED on first flag', async () => {
      const review = baseReview();
      mockReviewsRepo.findOne.mockResolvedValueOnce(review);
      mockModerationActionsRepo.findOne.mockResolvedValueOnce(null);

      await service.flag(reviewer, 1, {
        reason: 'This review looks fabricated.',
      });

      expect(mockModerationActionsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ action: ModerationAction.FLAG, reviewId: 1 }),
      );
      expect(review.status).toBe(ReviewStatus.FLAGGED);
    });

    it('does not trigger rating recalculation (a flagged review still counts)', async () => {
      const review = baseReview();
      mockReviewsRepo.findOne.mockResolvedValueOnce(review);
      mockModerationActionsRepo.findOne.mockResolvedValueOnce(null);

      await service.flag(reviewer, 1, {
        reason: 'This review looks fabricated.',
      });

      expect(mockArtisanProfileRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('findOne visibility (FL1)', () => {
    it('404s a FLAGGED review for a stranger', async () => {
      mockReviewsRepo.findOne.mockResolvedValueOnce(
        baseReview({ status: ReviewStatus.FLAGGED }),
      );
      await expect(service.findOne(1, 999)).rejects.toThrow(NotFoundException);
    });

    it('404s a FLAGGED review for an unauthenticated caller', async () => {
      mockReviewsRepo.findOne.mockResolvedValueOnce(
        baseReview({ status: ReviewStatus.FLAGGED }),
      );
      await expect(service.findOne(1, undefined)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('still returns a FLAGGED review to its original reviewer', async () => {
      mockReviewsRepo.findOne.mockResolvedValueOnce(
        baseReview({ status: ReviewStatus.FLAGGED }),
      );
      const result = await service.findOne(1, reviewer.id);
      expect(result.data.status).toBe(ReviewStatus.FLAGGED);
    });

    it('returns an ACTIVE review to anyone', async () => {
      mockReviewsRepo.findOne.mockResolvedValueOnce(baseReview());
      const result = await service.findOne(1, undefined);
      expect(result.data.verifiedBooking).toBe(true);
    });
  });

  describe('adminRemove (AM3 — hard delete)', () => {
    it('writes a moderation log entry, deletes the review, and recalculates ratings', async () => {
      const review = baseReview();
      mockReviewsRepo.findOne.mockResolvedValueOnce(review);

      await service.adminRemove(admin, 1, {
        reason: 'Confirmed fake review after investigation.',
      });

      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockModerationActionsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: ModerationAction.REMOVE,
          reviewId: 1,
          reviewExcerpt: 'Great work, very professional.',
          artisanName: 'Kofi Home Services',
        }),
      );
      expect(mockReviewsRepo.delete).toHaveBeenCalledWith(1);
      expect(mockArtisanProfileRepo.update).toHaveBeenCalledWith(
        artisanProfile.id,
        expect.objectContaining({ totalReviews: 2 }),
      );
    });

    it('404s for a nonexistent review', async () => {
      mockReviewsRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.adminRemove(admin, 999, { reason: 'Reason long enough.' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('adminRestore (AM4)', () => {
    it('rejects restoring a review that is not FLAGGED', async () => {
      mockReviewsRepo.findOne.mockResolvedValueOnce(
        baseReview({ status: ReviewStatus.ACTIVE }),
      );
      await expect(service.adminRestore(admin, 1)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('restores a FLAGGED review to ACTIVE and recalculates ratings', async () => {
      const review = baseReview({ status: ReviewStatus.FLAGGED });
      mockReviewsRepo.findOne.mockResolvedValueOnce(review);

      await service.adminRestore(admin, 1);

      expect(review.status).toBe(ReviewStatus.ACTIVE);
      expect(mockModerationActionsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: ModerationAction.RESTORE,
          reason: undefined,
        }),
      );
      expect(mockArtisanProfileRepo.update).toHaveBeenCalled();
    });
  });

  describe('RA2 — Bayesian weighted rating', () => {
    it('computes WR = (v/(v+m))*R + (m/(v+m))*C', async () => {
      mockPlatformRatingCache.getMean.mockReturnValue(4);
      mockReviewsRepo.createQueryBuilder.mockReturnValue(
        mockQueryBuilder({
          getRawOne: jest
            .fn()
            .mockResolvedValue({ averageRating: '5.00', totalReviews: '10' }),
        }),
      );
      const review = baseReview();
      mockReviewsRepo.findOne
        .mockResolvedValueOnce(review)
        .mockResolvedValueOnce(review);

      await service.update(reviewer.id, 1, { rating: 5 });

      const m = VARIABLES.RATING_BAYESIAN_MIN_VOTES;
      const expectedWr = Number(
        ((10 / (10 + m)) * 5 + (m / (10 + m)) * 4).toFixed(2),
      );

      expect(mockArtisanProfileRepo.update).toHaveBeenCalledWith(
        artisanProfile.id,
        expect.objectContaining({ weightedRating: expectedWr }),
      );
    });

    it('falls back to the platform mean when the artisan has zero reviews', async () => {
      mockPlatformRatingCache.getMean.mockReturnValue(3.2);
      mockReviewsRepo.createQueryBuilder.mockReturnValue(
        mockQueryBuilder({
          getRawOne: jest
            .fn()
            .mockResolvedValue({ averageRating: '0', totalReviews: '0' }),
        }),
      );
      const review = baseReview();
      mockReviewsRepo.findOne
        .mockResolvedValueOnce(review)
        .mockResolvedValueOnce(review);

      await service.update(reviewer.id, 1, { rating: 5 });

      expect(mockArtisanProfileRepo.update).toHaveBeenCalledWith(
        artisanProfile.id,
        expect.objectContaining({ weightedRating: 3.2 }),
      );
    });
  });
});
