/**
 * Customer experience v2, B7a `GET /jobs/mine/summary` and B7b multi-status
 * `GET /jobs/mine` (test plan E-1.1 to E-1.10, SEC-6/T-1, T-2, T-6).
 *
 * Fixture A38: 38 jobs for customer A (OPEN 3, PENDING 1, IN_PROGRESS 2,
 * COMPLETED 27, CANCELLED 4, EXPIRED 1); customer B has 5 jobs. All names,
 * emails and amounts are fictional.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { DataSource, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import cookieParser from 'cookie-parser';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { User } from '@users/entities/user.entity';
import { UserTokenService } from '@users/token.service';
import { ServiceEntity } from '@services/entities/service.entity';
import { Role, Status } from '@common/types/enums';
import { expectNoForbiddenFields } from './support/forbidden-fields';

jest.setTimeout(120000);

const PREV_LIMIT = process.env.CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE;
process.env.CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE = '12';

type Body = {
  status: string;
  message: string;
  data: unknown;
  meta: {
    pagination?: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
    error?: string;
    retryAfterSeconds?: number;
  };
};

describe('Customer jobs summary and multi-status list (B7a, B7b)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const userId: Record<string, number> = {};
  let serviceId = 0;
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });
  const get = (path: string, who = 'a') =>
    request(server()).get(`/api/v1${path}`).set(as(who));

  /** Inserts jobs with explicit created_at so ordering is deterministic. */
  async function insertJobs(
    customerId: number,
    statuses: Array<[Status, number]>,
    baseDaysAgo = 0,
  ): Promise<void> {
    let i = 0;
    for (const [status, n] of statuses) {
      for (let k = 0; k < n; k++, i++) {
        await dataSource.query(
          `INSERT INTO jobs (customer_id, service_id, title, location, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'Osu, Accra', $4, NOW() - ($5 || ' days')::interval, NOW())`,
          [
            customerId,
            serviceId,
            `${status} job ${i}`,
            status,
            baseDaysAgo + i * 11,
          ],
        );
      }
    }
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    const logger = app.get<WinstonLogger>(WINSTON_MODULE_NEST_PROVIDER);
    app.useGlobalFilters(new AllExceptionsFilter(logger), new TypeOrmFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix('api/v1', { exclude: ['/'] });
    await app.init();
    dataSource = moduleFixture.get(DataSource);

    const services: Repository<ServiceEntity> = moduleFixture.get(
      getRepositoryToken(ServiceEntity),
    );
    serviceId = (
      await services.save(
        services.create({
          name: `Summary Plumbing ${uniq}`,
          estimatedDurationMins: 60,
        }),
      )
    ).id;

    const users: Repository<User> = moduleFixture.get(getRepositoryToken(User));
    const tokens = moduleFixture.get(UserTokenService);
    const make = async (
      label: string,
      role: Role,
      first: string,
      last: string,
    ) => {
      const u = await users.save(
        users.create({
          email: `cjs-${label}-${uniq}@test.jinva.local`,
          username: `cjs${label}${uniq}`,
          firstname: first,
          lastname: last,
          role,
          accountVerified: true,
        }),
      );
      userId[label] = u.id;
      token[label] = (await tokens.createJWTTokens(u)).access_token;
    };
    await make('a', Role.CUSTOMER, 'Ama', 'Owusu');
    await make('b', Role.CUSTOMER, 'Kwame', 'Boateng');
    await make('n', Role.CUSTOMER, 'Esi', 'Nyarko');
    await make('artisan', Role.ARTISAN, 'Kofi', 'Asante');
    await make('admin', Role.ADMIN, 'Yaw', 'Darko');

    // A38. The newest 10 are not representative of the whole account.
    await insertJobs(userId.a, [
      [Status.OPEN, 3],
      [Status.IN_PROGRESS, 2],
      [Status.COMPLETED, 5],
      [Status.PENDING, 1],
      [Status.COMPLETED, 22],
      [Status.CANCELLED, 4],
      [Status.EXPIRED, 1],
    ]);
    // A deleted job never counts.
    await dataSource.query(
      `INSERT INTO jobs (customer_id, service_id, title, location, status, deleted_at)
       VALUES ($1, $2, 'Deleted job', 'Osu, Accra', 'OPEN', NOW())`,
      [userId.a, serviceId],
    );
    // B has 5 jobs, two of them IN_PROGRESS.
    await insertJobs(userId.b, [
      [Status.OPEN, 1],
      [Status.IN_PROGRESS, 2],
      [Status.COMPLETED, 2],
    ]);
  });

  afterAll(async () => {
    if (PREV_LIMIT === undefined) {
      delete process.env.CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE;
    } else {
      process.env.CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE = PREV_LIMIT;
    }
    await app.close();
  });

  describe('B7a summary', () => {
    it("E-1.1 counts all of A's jobs by status and stage, and none of B's", async () => {
      const res = await get('/jobs/mine/summary');
      expect(res.status).toBe(200);
      const body = res.body as Body;
      expect(body.message).toBe('Job summary retrieved');
      expect(body.data).toEqual({
        byStatus: {
          OPEN: 3,
          PENDING: 1,
          IN_PROGRESS: 2,
          COMPLETED: 27,
          CANCELLED: 4,
          EXPIRED: 1,
        },
        byStage: { open: 3, in_progress: 3, completed: 27, closed: 5 },
        total: 38,
      });
      expect(res.headers['cache-control']).toBe('private, no-store');
      expectNoForbiddenFields(body);
    });

    it('E-1.2 gives all zeros for a customer with no jobs', async () => {
      const res = await get('/jobs/mine/summary', 'n');
      expect(res.status).toBe(200);
      expect((res.body as Body).data).toEqual({
        byStatus: {
          OPEN: 0,
          PENDING: 0,
          IN_PROGRESS: 0,
          COMPLETED: 0,
          CANCELLED: 0,
          EXPIRED: 0,
        },
        byStage: { open: 0, in_progress: 0, completed: 0, closed: 0 },
        total: 0,
      });
    });

    it('E-1.3 needs a token and the customer role', async () => {
      expect(
        (await request(server()).get('/api/v1/jobs/mine/summary')).status,
      ).toBe(401);
      expect((await get('/jobs/mine/summary', 'artisan')).status).toBe(403);
      expect((await get('/jobs/mine/summary', 'admin')).status).toBe(403);
    });

    it('E-1.4 refuses owner parameters with 400', async () => {
      const r1 = await get(`/jobs/mine/summary?customerId=${userId.b}`);
      const r2 = await get(`/jobs/mine/summary?userId=${userId.b}`);
      expect(r1.status).toBe(400);
      expect(r2.status).toBe(400);
    });

    it('E-1.9 moves a job from in progress to completed when it is confirmed', async () => {
      const [job] = await dataSource.query<[Array<{ id: number }>, number]>(
        `UPDATE jobs SET status = 'COMPLETED' WHERE id = (
           SELECT id FROM jobs WHERE customer_id = $1 AND status = 'IN_PROGRESS' AND deleted_at IS NULL ORDER BY id LIMIT 1
         ) RETURNING id`,
        [userId.a],
      );
      expect(job).toBeDefined();
      const { data } = (await get('/jobs/mine/summary')).body as {
        data: {
          byStage: { in_progress: number; completed: number };
        };
      };
      expect(data.byStage.in_progress).toBe(2);
      expect(data.byStage.completed).toBe(28);
      await dataSource.query(
        `UPDATE jobs SET status = 'IN_PROGRESS' WHERE id = $1`,
        [job[0].id],
      );
    });
  });

  describe('B7b multi-status list', () => {
    it('E-1.5 returns PENDING and IN_PROGRESS together, newest first', async () => {
      const res = await get(
        '/jobs/mine?status=PENDING,IN_PROGRESS&page=1&limit=10',
      );
      expect(res.status).toBe(200);
      const body = res.body as Body;
      const rows = body.data as Array<{ status: string; createdAt: string }>;
      expect(rows).toHaveLength(3);
      expect(
        rows.every((r) => ['PENDING', 'IN_PROGRESS'].includes(r.status)),
      ).toBe(true);
      const times = rows.map((r) => new Date(r.createdAt).getTime());
      expect([...times].sort((x, y) => y - x)).toEqual(times);
      expect(body.meta.pagination).toEqual({
        page: 1,
        limit: 10,
        total: 3,
        totalPages: 1,
      });
      expectNoForbiddenFields(body);
    });

    it('E-1.6 pages through 27 COMPLETED jobs with no gaps or duplicates, stable on equal createdAt', async () => {
      // Two jobs share one createdAt so the id tie-break is exercised.
      await dataSource.query(
        `UPDATE jobs SET created_at = '2026-01-01T00:00:00' WHERE id IN (
           SELECT id FROM jobs WHERE customer_id = $1 AND status = 'COMPLETED' ORDER BY id LIMIT 2
         )`,
        [userId.a],
      );
      const seen: number[] = [];
      const sizes: number[] = [];
      for (const page of [1, 2, 3]) {
        const res = await get(
          `/jobs/mine?status=COMPLETED&limit=10&page=${page}`,
        );
        expect(res.status).toBe(200);
        const rows = (res.body as Body).data as Array<{ id: number }>;
        sizes.push(rows.length);
        seen.push(...rows.map((r) => r.id));
      }
      expect(sizes).toEqual([10, 10, 7]);
      expect(new Set(seen).size).toBe(27);
    });

    it('E-1.7 refuses bad statuses and paging', async () => {
      for (const q of [
        'status=FOO',
        'status=OPEN,FOO',
        'status=,',
        'status=open',
        'status=OPEN;DROP',
        'limit=101',
        'limit=51',
        'page=0',
      ]) {
        expect({ q, status: (await get(`/jobs/mine?${q}`)).status }).toEqual({
          q,
          status: 400,
        });
      }
    });

    it("E-1.8 keeps the single-status and no-status responses in today's shape", async () => {
      for (const path of ['/jobs/mine', '/jobs/mine?status=OPEN']) {
        const res = await get(path);
        expect(res.status).toBe(200);
        const body = res.body as Body;
        expect(Object.keys(body).sort()).toEqual([
          'data',
          'message',
          'meta',
          'status',
        ]);
        expect(Object.keys(body.meta.pagination ?? {})).toEqual([
          'total',
          'page',
          'limit',
          'totalPages',
        ]);
        expect(Array.isArray(body.data)).toBe(true);
      }
      const open = (await get('/jobs/mine?status=OPEN')).body as Body;
      expect((open.data as unknown[]).length).toBe(3);
      expect(open.meta.pagination?.total).toBe(3);
    });

    it("E-1.10 never returns another customer's jobs", async () => {
      const res = await get('/jobs/mine?status=IN_PROGRESS');
      const rows = (res.body as Body).data as Array<{
        customer?: { id: number };
      }>;
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.customer?.id === userId.a)).toBe(true);
      const b = await get('/jobs/mine?status=IN_PROGRESS', 'b');
      expect(((b.body as Body).data as unknown[]).length).toBe(2);
    });

    it('refuses owner parameters on the list too', async () => {
      expect((await get(`/jobs/mine?customerId=${userId.b}`)).status).toBe(400);
    });
  });

  it('T-6 the summary is throttled per user with the customer-analytics contract', async () => {
    // The limit is overridden to 12 for this file; A has used a few already.
    let last = await get('/jobs/mine/summary', 'n');
    for (let i = 0; i < 12 && last.status === 200; i++) {
      last = await get('/jobs/mine/summary', 'n');
    }
    expect(last.status).toBe(429);
    const body = last.body as Body;
    expect(body.message).toBe('Too many requests, please wait a moment.');
    expect(body.meta.error).toBe('CUSTOMER_ANALYTICS_RATE_LIMIT_EXCEEDED');
    expect(body.meta.retryAfterSeconds).toBeGreaterThan(0);
    expect(last.headers['retry-after']).toBeDefined();
    // Another customer has their own bucket.
    expect((await get('/jobs/mine/summary', 'b')).status).toBe(200);
  });
});
