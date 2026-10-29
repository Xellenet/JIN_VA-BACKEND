import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import * as bcrypt from 'bcrypt';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { User } from '@users/entities/user.entity';
import { Role } from '@common/types/enums';

/**
 * Auth rate limiting (closes the "POST /auth/login has no rate limiting at
 * all" finding from the auth-settings-closeout round, which
 * POST /auth/restore-account inherited).
 *
 * Booted with production's real global wiring (AllExceptionsFilter +
 * TypeOrmFilter + ResponseInterceptor + ValidationPipe + the /api/v1 prefix),
 * because the thing under test is the *body a browser receives* — the guard
 * throws an HttpException whose response object only reaches the client through
 * that filter, and getting exactly this wrong is what QA B1 caught in the
 * messaging round.
 *
 * Run: npm run test:e2e -- auth-rate-limit
 *
 * The assertions are order-dependent within the file: the throttler's counters
 * are per (route, tracker) and live in-process for 60 seconds, so a test that
 * exhausts login's bucket is also the setup for the tests that check what an
 * exhausted bucket does and does not leak. Each block says which state it
 * relies on.
 *
 * Test code only. Fixtures removed in `afterAll`.
 */
jest.setTimeout(120000);

/** Must match `AUTH_RATE_LIMIT_PER_MINUTE`'s default in `ThrottlingModule`. */
const CREDENTIALS_LIMIT = 10;
/** Must match `AUTH_EMAIL_RATE_LIMIT_PER_MINUTE`'s default. */
const EMAIL_LIMIT = 5;

interface ErrorBody {
  status?: string;
  message?: string;
  meta?: {
    error?: string;
    statusCode?: number;
    retryAfterSeconds?: number;
    path?: string;
    timestamp?: string;
  };
  access_token?: string;
}

describe('Auth abuse rate limiting, with production global filters (e2e)', () => {
  let app: INestApplication<App>;
  let userRepo: Repository<User>;

  let realUser: User;
  const uniq = Date.now();
  /** A genuinely registered, verified account with a password we know. */
  const realEmail = `qa-authrl-real-${uniq}@test.jinva.local`;
  const realPassword = 'CorrectHorse1!';
  /** An address that is definitely not registered. */
  const unknownEmail = `qa-authrl-absent-${uniq}@test.jinva.local`;

  const server = () => app.getHttpServer();

  const login = (email: string, password: string) =>
    request(server()).post('/api/v1/auth/login').send({ email, password });

  const forgotPassword = (email: string) =>
    request(server()).post('/api/v1/auth/forgot-password').send({ email });

  /** The parts of a 429 that must not vary between callers. */
  const comparableBody = (res: request.Response) => {
    const body = res.body as ErrorBody;
    return {
      status: res.status,
      envelopeStatus: body.status,
      message: body.message,
      error: body.meta?.error,
      statusCode: body.meta?.statusCode,
    };
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    const logger = app.get<WinstonLogger>(WINSTON_MODULE_NEST_PROVIDER);

    // Mirror src/main.ts.
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

    userRepo = moduleFixture.get(getRepositoryToken(User));

    realUser = await userRepo.save(
      userRepo.create({
        email: realEmail,
        password: await bcrypt.hash(realPassword, 10),
        firstname: 'QaAuthRl',
        lastname: 'Real',
        role: Role.CUSTOMER,
        accountVerified: true,
        isBanned: false,
      }),
    );
  });

  afterAll(async () => {
    // Nothing else to clean up: the fixture account is never successfully
    // logged in (every attempt is a 401 or a 429), and forgot-password is only
    // ever called with addresses that don't exist, so no tokens are issued.
    try {
      await userRepo.delete({ id: realUser.id });
    } catch {
      /* ignore */
    }
    await app.close();
  });

  describe('POST /auth/login', () => {
    let firstRejection: request.Response;

    it(`allows ${CREDENTIALS_LIMIT} attempts and then rejects with 429, instead of accepting guesses forever`, async () => {
      for (let i = 0; i < CREDENTIALS_LIMIT; i++) {
        const res = await login(unknownEmail, `wrong-guess-${i}!`);
        // Every attempt inside the quota still gets the ordinary
        // enumeration-safe 401 — the limit changes nothing until it is hit.
        expect(res.status).toBe(401);
      }

      firstRejection = await login(unknownEmail, 'wrong-guess-final!');
      expect(firstRejection.status).toBe(429);
    });

    it('returns the documented 429 envelope, not a bare "Too many requests" and not a 500', () => {
      const body = firstRejection.body as ErrorBody;

      expect(body.status).toBe('error');
      expect(body.message).toMatch(/^Too many attempts\. Please try again in/);
      expect(body.message).not.toMatch(/ThrottlerException/);
      expect(body.meta?.statusCode).toBe(429);
      expect(body.meta?.error).toBe('AUTH_RATE_LIMIT_EXCEEDED');
      expect(typeof body.meta?.retryAfterSeconds).toBe('number');
      expect(body.meta?.retryAfterSeconds as number).toBeGreaterThan(0);
    });

    it('says exactly the same thing for a real account as for one that does not exist, even with the correct password', async () => {
      // Relies on the bucket exhausted above. The tracker is the client IP, so
      // switching to a registered address does not buy a fresh quota — and
      // because the guard runs ahead of the handler, a *correct* password gets
      // the same rejection, with no session issued.
      const knownEmailAttempt = await login(realEmail, realPassword);

      expect(knownEmailAttempt.status).toBe(429);
      expect(comparableBody(knownEmailAttempt)).toEqual(
        comparableBody(firstRejection),
      );

      const body = knownEmailAttempt.body as ErrorBody;
      expect(body.access_token).toBeUndefined();
      expect(knownEmailAttempt.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('per-route buckets', () => {
    it('leaves the other auth routes usable when login has been exhausted', async () => {
      // A brute-force run against login must not deny a bystander on the same
      // NAT the ability to start a password reset.
      const res = await forgotPassword(unknownEmail);
      expect(res.status).toBe(200);
    });

    it(`limits the mail-sending routes separately and more tightly (${EMAIL_LIMIT}/minute)`, async () => {
      // One call was already spent above; the rest of the quota still answers
      // 200 (deliberately, for enumeration safety) before the limit bites.
      for (let i = 1; i < EMAIL_LIMIT; i++) {
        const res = await forgotPassword(`${unknownEmail}.${i}`);
        expect(res.status).toBe(200);
      }

      const rejected = await forgotPassword(`${unknownEmail}.over`);
      expect(rejected.status).toBe(429);
      expect((rejected.body as ErrorBody).meta?.error).toBe(
        'AUTH_RATE_LIMIT_EXCEEDED',
      );
      // Same copy as the credential limit's rejection: a 429 must not reveal
      // which limit, or which endpoint, the caller tripped.
      expect((rejected.body as ErrorBody).message).toMatch(
        /^Too many attempts\. Please try again in/,
      );
    });
  });
});
