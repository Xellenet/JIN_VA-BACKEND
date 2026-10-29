import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { Job } from '@jobs/entities/job.entity';
import { Review } from '../src/reviews/entities/review.entity';
import { ReviewPhoto } from '../src/reviews/entities/review-photo.entity';
import { ReviewModerationAction } from '../src/reviews/entities/review-moderation-action.entity';
import { UserTokenService } from '@users/token.service';
import {
  Role,
  Status,
  ReviewStatus,
  ModerationAction,
} from '@common/types/enums';

/**
 * QA verification (reviews-ratings-favourites, docs/team/reviews-ratings-favourites).
 *
 * A REAL end-to-end run — genuine HTTP requests via supertest against a live
 * Nest application backed by the real Postgres connection (not a unit test
 * mocking the DB/service layer) — covering the full review lifecycle named in
 * the feature's Definition of Done: submit -> edit within 48h (incl. after
 * being flagged) -> photo attachment limits (RP1) -> artisan reply once (AR1)
 * -> a different user flags it, hiding it immediately (FL1) -> admin
 * permanently removes it with a reason (AM3, hard delete verified directly
 * against the reviews/review_photos/review_moderation_actions tables via the
 * injected repositories) -> rating recalculates at every step (RA1/RA2) ->
 * admin restores a still-FLAGGED (not removed) review (AM4) -> non-admin
 * callers get 403 on every /admin/reviews/* route -> the FB1 favourites
 * bug-fix response shape against the real endpoint.
 *
 * Run: npm run test:e2e -- reviews-lifecycle
 *
 * This is QA test code only (per QA's role boundary) — no application/feature
 * code is touched by this file. All fixtures created here are cleaned up in
 * `afterAll`.
 */
// Full app bootstrap (DB connection + entity/migration metadata load) plus a
// chain of sequential HTTP+DB round trips per test comfortably exceeds
// Jest's 5000ms default hook/test timeout on this machine — raise it for
// this file only, same fix `beforeAll`'s own doc comment would ask for.
jest.setTimeout(60000);

// Minimal shapes for asserting on response bodies without `any` — supertest's
// `Response.body` is untyped, so every access is cast through these once
// instead of leaving `no-unsafe-member-access` violations scattered around.
interface Envelope<T> {
  data: T;
}
interface MiniReview {
  id: number;
  status: string;
  rating: number;
  editedAt: string | null;
  verifiedBooking: boolean;
  artisanReply: string | null;
  photos: unknown[];
}
interface MiniAdminReview extends MiniReview {
  flags: { reason: string; actorName: string; createdAt: string }[];
}
interface MiniFavourite {
  id: number;
  favouritedAt?: string;
  completedJobsCount?: number;
}
interface MiniModerationEntry {
  reviewId: number;
  action: string;
}

function envelope<T>(res: request.Response): T {
  return (res.body as Envelope<T>).data;
}

describe('Reviews, Ratings & Favourites — full lifecycle (e2e)', () => {
  let app: INestApplication<App>;

  let userRepo: Repository<User>;
  let profileRepo: Repository<ArtisanProfile>;
  let serviceRepo: Repository<ServiceEntity>;
  let jobRepo: Repository<Job>;
  let reviewRepo: Repository<Review>;
  let reviewPhotoRepo: Repository<ReviewPhoto>;
  let moderationRepo: Repository<ReviewModerationAction>;
  let tokenService: UserTokenService;

  let artisanUser: User;
  let artisanProfile: ArtisanProfile;
  let artisanToken: string;
  let artisan2User: User;
  let artisan2Token: string;
  let customer1: User;
  let customer1Token: string;
  let customer2: User;
  let customer2Token: string;
  let adminUser: User;
  let adminToken: string;
  let service: ServiceEntity;

  const server = () => app.getHttpServer();
  const uniq = Date.now();

  async function makeCompletedJob(title: string): Promise<Job> {
    return jobRepo.save(
      jobRepo.create({
        customer: customer1,
        service,
        status: Status.COMPLETED,
        acceptedArtisan: artisanUser,
        title,
        location: 'QA Test Location, Accra',
        currency: 'GHS',
      }),
    );
  }

  // Minimal, genuinely-valid 1x1 PNG (passes `file-type` magic-byte sniffing).
  const VALID_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );

  async function uploadReviewPhoto(token: string): Promise<string> {
    const res = await request(server())
      .post('/api/v1/uploads/review-photo')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', VALID_PNG, {
        filename: 'photo.png',
        contentType: 'image/png',
      });
    expect(res.status).toBe(200);
    return envelope<{ url: string }>(res).url;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix('api/v1', { exclude: ['/'] });
    await app.init();

    userRepo = moduleFixture.get(getRepositoryToken(User));
    profileRepo = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    serviceRepo = moduleFixture.get(getRepositoryToken(ServiceEntity));
    jobRepo = moduleFixture.get(getRepositoryToken(Job));
    reviewRepo = moduleFixture.get(getRepositoryToken(Review));
    reviewPhotoRepo = moduleFixture.get(getRepositoryToken(ReviewPhoto));
    moderationRepo = moduleFixture.get(
      getRepositoryToken(ReviewModerationAction),
    );
    tokenService = moduleFixture.get(UserTokenService);

    service = await serviceRepo.save(
      serviceRepo.create({
        name: `QA Reviews Test Service ${uniq}`,
        estimatedDurationMins: 60,
      }),
    );

    artisanUser = await userRepo.save(
      userRepo.create({
        email: `qa-reviews-artisan-${uniq}@test.jinva.local`,
        password: null,
        firstname: 'QaReviews',
        lastname: 'Artisan',
        role: Role.ARTISAN,
        accountVerified: true,
        isBanned: false,
      }),
    );
    artisanProfile = await profileRepo.save(
      profileRepo.create({
        user: artisanUser,
        currency: 'GHS',
        isVerified: true,
        isProfileComplete: true,
      }),
    );
    artisanToken = (await tokenService.createJWTTokens(artisanUser))
      .access_token;

    artisan2User = await userRepo.save(
      userRepo.create({
        email: `qa-reviews-artisan2-${uniq}@test.jinva.local`,
        password: null,
        firstname: 'QaReviews',
        lastname: 'ArtisanTwo',
        role: Role.ARTISAN,
        accountVerified: true,
        isBanned: false,
      }),
    );
    await profileRepo.save(
      profileRepo.create({
        user: artisan2User,
        currency: 'GHS',
        isVerified: true,
        isProfileComplete: true,
      }),
    );
    artisan2Token = (await tokenService.createJWTTokens(artisan2User))
      .access_token;

    customer1 = await userRepo.save(
      userRepo.create({
        email: `qa-reviews-customer1-${uniq}@test.jinva.local`,
        password: null,
        firstname: 'QaReviews',
        lastname: 'CustomerOne',
        role: Role.CUSTOMER,
        accountVerified: true,
        isBanned: false,
      }),
    );
    customer1Token = (await tokenService.createJWTTokens(customer1))
      .access_token;

    customer2 = await userRepo.save(
      userRepo.create({
        email: `qa-reviews-customer2-${uniq}@test.jinva.local`,
        password: null,
        firstname: 'QaReviews',
        lastname: 'CustomerTwo',
        role: Role.CUSTOMER,
        accountVerified: true,
        isBanned: false,
      }),
    );
    customer2Token = (await tokenService.createJWTTokens(customer2))
      .access_token;

    adminUser = await userRepo.save(
      userRepo.create({
        email: `qa-reviews-admin-${uniq}@test.jinva.local`,
        password: null,
        firstname: 'QaReviews',
        lastname: 'Admin',
        role: Role.ADMIN,
        accountVerified: true,
        isBanned: false,
      }),
    );
    adminToken = (await tokenService.createJWTTokens(adminUser)).access_token;
  });

  afterAll(async () => {
    // Best-effort cleanup — leaves the shared dev DB as clean as this test
    // found it. Order matters for FKs; swallow errors from rows already
    // gone (e.g. the hard-deleted review under test).
    try {
      await moderationRepo.delete({ artisanProfileId: artisanProfile.id });
    } catch {
      /* ignore */
    }
    try {
      await reviewRepo
        .createQueryBuilder()
        .delete()
        .where('artisan_profile_id = :id', { id: artisanProfile.id })
        .execute();
    } catch {
      /* ignore */
    }
    try {
      await jobRepo
        .createQueryBuilder()
        .delete()
        .where('accepted_artisan_id = :id', { id: artisanUser.id })
        .execute();
    } catch {
      /* ignore */
    }
    try {
      await profileRepo.delete({ id: artisanProfile.id });
    } catch {
      /* ignore */
    }
    try {
      await userRepo.delete({
        id: In(
          [
            artisanUser.id,
            artisan2User.id,
            customer1.id,
            customer2.id,
            adminUser.id,
          ].filter(Boolean),
        ),
      });
    } catch {
      /* ignore */
    }
    try {
      await serviceRepo.delete({ id: service.id });
    } catch {
      /* ignore */
    }
    await app.close();
  });

  // ─── FB1: favourites bug-fix, against the real running endpoint ────────────

  it('FB1: GET /favourites returns { data: [...] } (not { items }) with favouritedAt/completedJobsCount, and reflects a just-added favourite', async () => {
    const add = await request(server())
      .post(`/api/v1/favourites/${artisanProfile.id}`)
      .set('Authorization', `Bearer ${customer1Token}`);
    expect(add.status).toBe(200);

    const list = await request(server())
      .get('/api/v1/favourites')
      .set('Authorization', `Bearer ${customer1Token}`);
    expect(list.status).toBe(200);
    const favourites = envelope<MiniFavourite[]>(list);
    expect(Array.isArray(favourites)).toBe(true);
    expect((list.body as { items?: unknown }).items).toBeUndefined();
    const entry = favourites.find((a) => a.id === artisanProfile.id);
    expect(entry).toBeDefined();
    expect(entry?.favouritedAt).toBeTruthy();
    expect(typeof entry?.completedJobsCount).toBe('number');

    const remove = await request(server())
      .delete(`/api/v1/favourites/${artisanProfile.id}`)
      .set('Authorization', `Bearer ${customer1Token}`);
    expect(remove.status).toBe(200);
  });

  // ─── RV1 / RA1: submit + RP1 photos ──────────────────────────────────────

  let jobA: Job;
  let reviewAId: number;

  it('RV1/RP1/RA1: submits a review with 3 photos on a COMPLETED job and recalculates the artisan rating', async () => {
    jobA = await makeCompletedJob('QA lifecycle job A');
    const photoUrls = [
      await uploadReviewPhoto(customer1Token),
      await uploadReviewPhoto(customer1Token),
      await uploadReviewPhoto(customer1Token),
    ];

    const before = await profileRepo.findOneOrFail({
      where: { id: artisanProfile.id },
    });
    expect(Number(before.totalReviews)).toBe(0);

    const res = await request(server())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${customer1Token}`)
      .send({
        jobId: jobA.id,
        rating: 4,
        review: 'Solid work, arrived on time and cleaned up afterwards.',
        photoUrls,
      });

    expect(res.status).toBe(201);
    const created = envelope<MiniReview>(res);
    expect(created.status).toBe('ACTIVE');
    expect(created.verifiedBooking).toBe(true);
    expect(created.photos).toHaveLength(3);
    reviewAId = created.id;

    const after = await profileRepo.findOneOrFail({
      where: { id: artisanProfile.id },
    });
    expect(Number(after.totalReviews)).toBe(1);
    expect(Number(after.averageRating)).toBeCloseTo(4, 2);
  });

  it('RP1: rejects a 4th photo, an oversized photo, and a wrong-type file', async () => {
    const jobD = await makeCompletedJob(
      'QA lifecycle job D (photo edge cases)',
    );
    const urls = [
      await uploadReviewPhoto(customer1Token),
      await uploadReviewPhoto(customer1Token),
      await uploadReviewPhoto(customer1Token),
      await uploadReviewPhoto(customer1Token),
    ];
    const tooMany = await request(server())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${customer1Token}`)
      .send({
        jobId: jobD.id,
        rating: 5,
        review: 'This review has four photo urls attached.',
        photoUrls: urls,
      });
    expect(tooMany.status).toBe(400);

    const oversized = Buffer.alloc(6 * 1024 * 1024, 1);
    const oversizedRes = await request(server())
      .post('/api/v1/uploads/review-photo')
      .set('Authorization', `Bearer ${customer1Token}`)
      .attach('file', oversized, {
        filename: 'big.png',
        contentType: 'image/png',
      });
    expect(oversizedRes.status).toBe(400);

    const wrongType = Buffer.from('this is a plain text file, not an image');
    const wrongTypeRes = await request(server())
      .post('/api/v1/uploads/review-photo')
      .set('Authorization', `Bearer ${customer1Token}`)
      .attach('file', wrongType, {
        filename: 'notes.png',
        contentType: 'image/png',
      });
    expect(wrongTypeRes.status).toBe(400);

    await jobRepo.delete(jobD.id);
  });

  // ─── RE1: edit within 48h, ownership, expired window ───────────────────────

  it('RE1: the original reviewer can edit within the 48h window and rating recalculates', async () => {
    const res = await request(server())
      .patch(`/api/v1/reviews/${reviewAId}`)
      .set('Authorization', `Bearer ${customer1Token}`)
      .send({
        rating: 5,
        review: 'Updating my review — even better on reflection, would rebook.',
      });
    expect(res.status).toBe(200);
    const updated = envelope<MiniReview>(res);
    expect(updated.editedAt).toBeTruthy();
    expect(Number(updated.rating)).toBe(5);

    const profile = await profileRepo.findOneOrFail({
      where: { id: artisanProfile.id },
    });
    expect(Number(profile.averageRating)).toBeCloseTo(5, 2);
  });

  it('RE1: rejects an edit attempt from a user who is not the original reviewer', async () => {
    const res = await request(server())
      .patch(`/api/v1/reviews/${reviewAId}`)
      .set('Authorization', `Bearer ${customer2Token}`)
      .send({ rating: 1 });
    expect(res.status).toBe(403);
  });

  it('RE1: rejects an edit once the 48-hour server-clock window has elapsed', async () => {
    const jobC = await makeCompletedJob(
      'QA lifecycle job C (expired edit window)',
    );
    const create = await request(server())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${customer1Token}`)
      .send({
        jobId: jobC.id,
        rating: 3,
        review: 'This review will be backdated to test the 48h window.',
      });
    expect(create.status).toBe(201);
    const reviewCId = envelope<MiniReview>(create).id;

    // Backdate createdAt directly via the injected repository (test fixture
    // manipulation of a row this test itself created — not a raw ad-hoc DB
    // mutation of shared data) to simulate the passage of 49 hours without
    // an actual 49-hour wait.
    await reviewRepo
      .createQueryBuilder()
      .update(Review)
      .set({ createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000) })
      .where('id = :id', { id: reviewCId })
      .execute();

    const res = await request(server())
      .patch(`/api/v1/reviews/${reviewCId}`)
      .set('Authorization', `Bearer ${customer1Token}`)
      .send({ rating: 2 });
    expect(res.status).toBe(403);

    await reviewRepo.delete(reviewCId);
    await jobRepo.delete(jobC.id);
  });

  // ─── AR1: artisan reply once ────────────────────────────────────────────

  it('AR1: the reviewed artisan can reply once; a second attempt and a different artisan are both rejected', async () => {
    const first = await request(server())
      .post(`/api/v1/reviews/${reviewAId}/replies`)
      .set('Authorization', `Bearer ${artisanToken}`)
      .send({ reply: 'Thank you for the kind words — glad we could help!' });
    expect(first.status).toBe(201);
    expect(envelope<MiniReview>(first).artisanReply).toBeTruthy();

    const second = await request(server())
      .post(`/api/v1/reviews/${reviewAId}/replies`)
      .set('Authorization', `Bearer ${artisanToken}`)
      .send({ reply: 'Trying to reply again.' });
    expect(second.status).toBe(409);

    const wrongArtisan = await request(server())
      .post(`/api/v1/reviews/${reviewAId}/replies`)
      .set('Authorization', `Bearer ${artisan2Token}`)
      .send({ reply: 'I am not the artisan this review is about.' });
    expect(wrongArtisan.status).toBe(403);
  });

  // ─── FL1: flagging hides immediately, except from the original reviewer ────

  it('FL1: a different user flagging the review hides it immediately from public reads, but not from the original reviewer; aggregation is unchanged', async () => {
    const beforeProfile = await profileRepo.findOneOrFail({
      where: { id: artisanProfile.id },
    });

    const flag = await request(server())
      .post(`/api/v1/reviews/${reviewAId}/flag`)
      .set('Authorization', `Bearer ${customer2Token}`)
      .send({
        reason: 'This review looks suspicious and needs a second look.',
      });
    // Fixed (qa-report.md "POST /reviews/:id/flag returns 201, not the
    // documented 200"): ReviewsController.flag() now has
    // @HttpCode(HttpStatus.OK), matching api-contract.md §7 and the
    // equivalent favourites endpoints.
    expect(flag.status).toBe(200);

    const anonymousList = await request(server()).get(
      `/api/v1/reviews/artisan-profile/${artisanProfile.id}`,
    );
    expect(anonymousList.status).toBe(200);
    expect(
      envelope<MiniReview[]>(anonymousList).some((r) => r.id === reviewAId),
    ).toBe(false);

    const ownerList = await request(server())
      .get(`/api/v1/reviews/artisan-profile/${artisanProfile.id}`)
      .set('Authorization', `Bearer ${customer1Token}`);
    const ownerCopy = envelope<MiniReview[]>(ownerList).find(
      (r) => r.id === reviewAId,
    );
    expect(ownerCopy).toBeDefined();
    expect(ownerCopy?.status).toBe('FLAGGED');

    // Duplicate flag by the same actor is rejected.
    const dup = await request(server())
      .post(`/api/v1/reviews/${reviewAId}/flag`)
      .set('Authorization', `Bearer ${customer2Token}`)
      .send({ reason: 'Flagging again from the same account.' });
    expect(dup.status).toBe(409);

    // A second flag from a genuinely different user is accepted (and logged).
    const secondFlagger = await request(server())
      .post(`/api/v1/reviews/${reviewAId}/flag`)
      .set('Authorization', `Bearer ${artisan2Token}`)
      .send({ reason: 'Independently reporting the same review.' });
    expect(secondFlagger.status).toBe(200); // fixed — see the @HttpCode note above

    // RA1: a FLAGGED-but-not-removed review still counts toward aggregation.
    const afterProfile = await profileRepo.findOneOrFail({
      where: { id: artisanProfile.id },
    });
    expect(Number(afterProfile.totalReviews)).toBe(
      Number(beforeProfile.totalReviews),
    );
    expect(Number(afterProfile.averageRating)).toBeCloseTo(
      Number(beforeProfile.averageRating),
      2,
    );
  });

  it('Edge case: the original reviewer can still edit a FLAGGED review, and the flag is not cleared by the edit', async () => {
    const res = await request(server())
      .patch(`/api/v1/reviews/${reviewAId}`)
      .set('Authorization', `Bearer ${customer1Token}`)
      .send({
        review: 'Edited while under moderation — still stands by the rating.',
      });
    expect(res.status).toBe(200);
    expect(envelope<MiniReview>(res).status).toBe('FLAGGED');
  });

  // ─── Non-admin 403 on every /admin/reviews/* route ─────────────────────────

  it('rejects a non-admin (CUSTOMER and ARTISAN) on every /admin/reviews/* route with 403', async () => {
    const nonAdminTokens = [customer1Token, artisanToken];
    for (const token of nonAdminTokens) {
      const list = await request(server())
        .get('/api/v1/admin/reviews')
        .set('Authorization', `Bearer ${token}`);
      expect(list.status).toBe(403);

      const log = await request(server())
        .get('/api/v1/admin/reviews/moderation-log')
        .set('Authorization', `Bearer ${token}`);
      expect(log.status).toBe(403);

      const remove = await request(server())
        .patch(`/api/v1/admin/reviews/${reviewAId}/remove`)
        .set('Authorization', `Bearer ${token}`)
        .send({ reason: 'Attempting removal without admin rights.' });
      expect(remove.status).toBe(403);

      const restore = await request(server())
        .patch(`/api/v1/admin/reviews/${reviewAId}/restore`)
        .set('Authorization', `Bearer ${token}`);
      expect(restore.status).toBe(403);
    }
  });

  // ─── AM2/AM3/AM5: admin hard-remove ─────────────────────────────────────

  it('AM2: the admin moderation queue lists the flagged review with its flag history', async () => {
    const res = await request(server())
      .get('/api/v1/admin/reviews?status=FLAGGED')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = envelope<MiniAdminReview[]>(res).find(
      (r) => r.id === reviewAId,
    );
    expect(row).toBeDefined();
    expect(row?.flags.length).toBeGreaterThanOrEqual(2);
  });

  it('AM3/AM5: admin permanently removes the review with a reason — the row is hard-deleted, logged, and rating recalculates', async () => {
    const beforeProfile = await profileRepo.findOneOrFail({
      where: { id: artisanProfile.id },
    });

    const noReason = await request(server())
      .patch(`/api/v1/admin/reviews/${reviewAId}/remove`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'x' }); // too short — REVIEW_MODERATION_REASON_MIN_LENGTH is 10
    expect(noReason.status).toBe(400);

    const remove = await request(server())
      .patch(`/api/v1/admin/reviews/${reviewAId}/remove`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Confirmed policy violation after investigation.' });
    expect(remove.status).toBe(200);

    // The row is ACTUALLY gone, not soft-hidden.
    const dbRow = await reviewRepo.findOne({ where: { id: reviewAId } });
    expect(dbRow).toBeNull();
    const photos = await reviewPhotoRepo.find({
      where: { reviewId: reviewAId },
    });
    expect(photos).toHaveLength(0);

    const publicFetch = await request(server()).get(
      `/api/v1/reviews/${reviewAId}`,
    );
    expect(publicFetch.status).toBe(404);
    const ownerFetch = await request(server())
      .get(`/api/v1/reviews/${reviewAId}`)
      .set('Authorization', `Bearer ${customer1Token}`);
    expect(ownerFetch.status).toBe(404); // gone for everyone, including the original reviewer

    const logEntry = await moderationRepo.findOne({
      where: { reviewId: reviewAId, action: ModerationAction.REMOVE },
    });
    expect(logEntry).toBeTruthy();
    expect(logEntry?.reason).toContain('Confirmed policy violation');
    expect(logEntry?.reviewExcerpt).toBeTruthy();

    const afterProfile = await profileRepo.findOneOrFail({
      where: { id: artisanProfile.id },
    });
    expect(Number(afterProfile.totalReviews)).toBe(
      Number(beforeProfile.totalReviews) - 1,
    );
  });

  it('AM5: the moderation log endpoint surfaces the REMOVE action for an admin', async () => {
    const res = await request(server())
      .get('/api/v1/admin/reviews/moderation-log?limit=100')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const entry = envelope<MiniModerationEntry[]>(res).find(
      (e) => e.reviewId === reviewAId && e.action === 'REMOVE',
    );
    expect(entry).toBeDefined();
  });

  // ─── AM4: restore a still-FLAGGED (not removed) review ─────────────────────

  let reviewBId: number;

  it('AM4: admin restores a still-FLAGGED (not yet removed) review and it reappears publicly', async () => {
    const jobB = await makeCompletedJob('QA lifecycle job B (flag + restore)');
    const create = await request(server())
      .post('/api/v1/reviews')
      .set('Authorization', `Bearer ${customer1Token}`) // jobB.customer is always customer1 (makeCompletedJob)
      .send({
        jobId: jobB.id,
        rating: 2,
        review: 'This artisan review will be flagged then restored.',
      });
    expect(create.status).toBe(201);
    reviewBId = envelope<MiniReview>(create).id;

    const flag = await request(server())
      .post(`/api/v1/reviews/${reviewBId}/flag`)
      .set('Authorization', `Bearer ${customer2Token}`) // a different user than the reviewer
      .send({ reason: 'Flagging this one to test the restore path.' });
    expect(flag.status).toBe(200); // fixed — see the @HttpCode note above

    const hiddenList = await request(server()).get(
      `/api/v1/reviews/artisan-profile/${artisanProfile.id}`,
    );
    expect(
      envelope<MiniReview[]>(hiddenList).some((r) => r.id === reviewBId),
    ).toBe(false);

    const restore = await request(server())
      .patch(`/api/v1/admin/reviews/${reviewBId}/restore`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(restore.status).toBe(200);

    const reviewRow = await reviewRepo.findOneOrFail({
      where: { id: reviewBId },
    });
    expect(reviewRow.status).toBe(ReviewStatus.ACTIVE);

    const visibleAgain = await request(server()).get(
      `/api/v1/reviews/artisan-profile/${artisanProfile.id}`,
    );
    expect(
      envelope<MiniReview[]>(visibleAgain).some((r) => r.id === reviewBId),
    ).toBe(true);
  });

  it('AM4: rejects restoring an ACTIVE review (400) and restoring a nonexistent/already-removed review (404)', async () => {
    const restoreActive = await request(server())
      .patch(`/api/v1/admin/reviews/${reviewBId}/restore`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(restoreActive.status).toBe(400);

    const restoreGone = await request(server())
      .patch(`/api/v1/admin/reviews/${reviewAId}/restore`) // already hard-deleted above
      .set('Authorization', `Bearer ${adminToken}`);
    expect(restoreGone.status).toBe(404);
  });
});
