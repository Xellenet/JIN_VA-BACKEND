import { NotFoundException } from '@nestjs/common';
import { ReviewStatus } from '@common/types/enums';
import { qbMock } from '../customer-insights/testing/qb-mock';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLES_KEY } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import { ArtisanInsightsThrottlerGuard } from '@common/throttling/artisan-throttler.guards';
import {
  ReviewSummaryService,
  toReviewSummary,
} from './review-summary.service';
import { ReviewsController } from './reviews.controller';

describe('ReviewSummaryService (B7)', () => {
  const build = (row: unknown, profile: unknown = { id: 7 }) => {
    const reviewsQb = qbMock({ getRawOne: row });
    const service = new ReviewSummaryService(
      { createQueryBuilder: jest.fn(() => reviewsQb) } as never,
      {
        createQueryBuilder: jest.fn(() =>
          qbMock({ getRawOne: profile ?? undefined }),
        ),
      } as never,
    );
    return { service, reviewsQb };
  };

  it('counts ACTIVE reviews of my profile, excluding rating-only from awaiting reply', async () => {
    const { service, reviewsQb } = build({
      total: '12',
      average: '4.5833',
      fourPlus: '10',
      awaitingReply: '2',
      s1: '0',
      s2: '1',
      s3: '1',
      s4: '4',
      s5: '6',
    });
    await expect(service.getMySummary(5)).resolves.toEqual({
      total: 12,
      average: '4.58',
      byStar: { '1': 0, '2': 1, '3': 1, '4': 4, '5': 6 },
      fourPlus: 10,
      fourPlusShare: 0.833,
      awaitingReply: 2,
    });
    expect(reviewsQb.params()).toMatchObject({
      profileId: 7,
      active: ReviewStatus.ACTIVE,
    });
    expect(reviewsQb.sql()).toContain("COALESCE(TRIM(r.review), '') <> ''");
    expect(reviewsQb.sql()).toContain('r.artisan_reply IS NULL');
  });

  it('reads no reviews as zeroes', () => {
    expect(toReviewSummary(undefined)).toEqual({
      total: 0,
      average: '0.00',
      byStar: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
      fourPlus: 0,
      fourPlusShare: 0,
      awaitingReply: 0,
    });
  });

  it('is 404 without an artisan profile', async () => {
    const { service } = build({}, null);
    await expect(service.getMySummary(5)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('GET /reviews/me/summary is artisan-only, throttled and owner-bound', async () => {
    const summary = { getMySummary: jest.fn().mockResolvedValue({ total: 1 }) };
    const controller = new ReviewsController({} as never, summary as never);
    await expect(
      controller.getMySummary({ user: { id: 5 } } as never, {}),
    ).resolves.toEqual({
      message: 'Review summary retrieved',
      data: { total: 1 },
    });
    expect(summary.getMySummary).toHaveBeenCalledWith(5);
    const handler = ReviewsController.prototype.getMySummary;
    expect(Reflect.getMetadata('__guards__', handler)).toEqual([
      JwtAuthGuard,
      RolesGuard,
      ArtisanInsightsThrottlerGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([Role.ARTISAN]);
  });
});
