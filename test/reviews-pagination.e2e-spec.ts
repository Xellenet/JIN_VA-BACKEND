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
import { UserTokenService } from '@users/token.service';
import { Role, Status } from '@common/types/enums';

/**
 * QA re-verification (reviews-ratings-favourites): confirms the backend
 * pagination contract that the frontend fix for
 * "Reviews are silently capped at the 10 most recent — no pagination UI
 * anywhere (violates RV2)" (qa-report.md, MAJOR) actually depends on.
 *
 * This does not re-test the frontend's rendering (covered separately via a
 * live browser pass) — it proves `GET /reviews/artisan-profile/:id` genuinely
 * paginates past 10 rows with the exact `page`/`limit` query params and
 * `meta.pagination` shape the frontend's `apiFetchWithMeta` calls now send,
 * so an artisan with 11+ reviews has every review reachable across pages
 * with no duplicates/gaps.
 *
 * QA test code only — no application/feature code touched. Fixtures cleaned
 * up in `afterAll`.
 *
 * Run: npm run test:e2e -- reviews-pagination
 */
jest.setTimeout(60000);

interface Envelope<T> {
  data: T;
  meta?: {
    pagination?: { total?: number; page?: number; totalPages?: number };
  };
}
interface MiniReview {
  id: number;
}

describe('Reviews — RV2 pagination past the default page size (e2e)', () => {
  let app: INestApplication<App>;

  let userRepo: Repository<User>;
  let profileRepo: Repository<ArtisanProfile>;
  let serviceRepo: Repository<ServiceEntity>;
  let jobRepo: Repository<Job>;
  let reviewRepo: Repository<Review>;
  let tokenService: UserTokenService;

  let artisanUser: User;
  let artisanProfile: ArtisanProfile;
  let customer: User;
  let customerToken: string;
  let service: ServiceEntity;
  const uniq = Date.now();
  const REVIEW_COUNT = 11;
  const createdReviewIds: number[] = [];

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
    tokenService = moduleFixture.get(UserTokenService);

    service = await serviceRepo.save(
      serviceRepo.create({
        name: `QA Pagination Test Service ${uniq}`,
        estimatedDurationMins: 60,
      }),
    );

    artisanUser = await userRepo.save(
      userRepo.create({
        email: `qa-pagination-artisan-${uniq}@test.jinva.local`,
        password: null,
        firstname: 'QaPagination',
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

    customer = await userRepo.save(
      userRepo.create({
        email: `qa-pagination-customer-${uniq}@test.jinva.local`,
        password: null,
        firstname: 'QaPagination',
        lastname: 'Customer',
        role: Role.CUSTOMER,
        accountVerified: true,
        isBanned: false,
      }),
    );
    customerToken = (await tokenService.createJWTTokens(customer)).access_token;

    // Create 11 distinct completed jobs (one review per job, per the existing
    // job_id unique constraint) and submit one review against each.
    for (let i = 0; i < REVIEW_COUNT; i++) {
      const job = await jobRepo.save(
        jobRepo.create({
          customer,
          service,
          status: Status.COMPLETED,
          acceptedArtisan: artisanUser,
          title: `QA pagination job ${i + 1}`,
          location: 'QA Test Location, Accra',
          currency: 'GHS',
        }),
      );
      const res = await request(app.getHttpServer())
        .post('/api/v1/reviews')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          jobId: job.id,
          rating: (i % 5) + 1,
          review: `QA pagination fixture review number ${i + 1} of ${REVIEW_COUNT}.`,
        });
      expect(res.status).toBe(201);
      createdReviewIds.push((res.body as Envelope<MiniReview>).data.id);
    }
  });

  afterAll(async () => {
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
      await userRepo.delete({ id: In([artisanUser.id, customer.id]) });
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

  it('RV2: totalReviews reflects all 11 reviews on the artisan profile, not just one page', async () => {
    const res = await request(app.getHttpServer()).get(
      `/api/v1/artisans/${artisanProfile.id}`,
    );
    expect(res.status).toBe(200);
    expect(
      Number(
        (res.body as { data: { totalReviews: number } }).data.totalReviews,
      ),
    ).toBe(REVIEW_COUNT);
  });

  it('RV2: GET /reviews/artisan-profile/:id?page=1&limit=10 returns exactly 10 rows and meta.pagination.totalPages=2', async () => {
    const res = await request(app.getHttpServer()).get(
      `/api/v1/reviews/artisan-profile/${artisanProfile.id}?page=1&limit=10`,
    );
    expect(res.status).toBe(200);
    const body = res.body as Envelope<MiniReview[]>;
    expect(body.data).toHaveLength(10);
    expect(body.meta?.pagination?.total).toBe(REVIEW_COUNT);
    expect(body.meta?.pagination?.totalPages).toBe(2);
  });

  it('RV2: page=2&limit=10 returns the remaining 1 review, with no overlap against page 1 (every review is reachable)', async () => {
    const page1 = await request(app.getHttpServer()).get(
      `/api/v1/reviews/artisan-profile/${artisanProfile.id}?page=1&limit=10`,
    );
    const page2 = await request(app.getHttpServer()).get(
      `/api/v1/reviews/artisan-profile/${artisanProfile.id}?page=2&limit=10`,
    );
    expect(page2.status).toBe(200);
    const page1Ids = (page1.body as Envelope<MiniReview[]>).data.map(
      (r) => r.id,
    );
    const page2Ids = (page2.body as Envelope<MiniReview[]>).data.map(
      (r) => r.id,
    );
    expect(page2Ids).toHaveLength(1);
    expect(page1Ids.filter((id) => page2Ids.includes(id))).toHaveLength(0);

    const allSeenIds = new Set([...page1Ids, ...page2Ids]);
    for (const id of createdReviewIds) {
      expect(allSeenIds.has(id)).toBe(true);
    }
  });

  it('RV2: omitting page/limit defaults to 10 (confirms the frontend regression this fixed — without explicit params, reviews 11+ are unreachable)', async () => {
    const res = await request(app.getHttpServer()).get(
      `/api/v1/reviews/artisan-profile/${artisanProfile.id}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as Envelope<MiniReview[]>;
    expect(body.data).toHaveLength(10);
    expect(body.meta?.pagination?.total).toBe(REVIEW_COUNT);
  });
});
