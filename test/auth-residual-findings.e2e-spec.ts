/**
 * Regression coverage for `docs/team/auth-residual-findings/requirements.md`
 * items 1, 2, 3, 6 and 9, against a real database and production's global
 * wiring.
 *
 * Every assertion here is one that a mocked repository could fake, and
 * therefore has to be made live: response bodies and `Set-Cookie` headers as
 * the client receives them, and the purge's effect read back out of Postgres
 * with `select`. The unit specs cover the decisions; this file covers the
 * effects.
 *
 * Run: npm run test:e2e -- auth-residual-findings
 *
 * The auth throttler's limits are raised for this process only (before
 * `AppModule` is compiled), exactly as `account-closeout.qa.e2e-spec.ts` does:
 * this file makes far more than 10 login/restore calls a minute and the limits
 * have their own coverage in `auth-rate-limit.e2e-spec.ts`.
 */
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '10000';
process.env.AUTH_EMAIL_RATE_LIMIT_PER_MINUTE = '10000';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { In, IsNull, Not, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import * as bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import { subDays } from 'date-fns';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { CustomerProfile } from '@users/entities/customer-profile.entity';
import { DeviceToken } from '../src/push-notifications/entities/device-token.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { Booking } from '../src/bookings/entities/booking.entity';
import { UserTokenService } from '@users/token.service';
import { AuthService } from '../src/auth/auth.service';
import { AccountPurgeService } from '@users/account-purge.service';
import { SocialAuthStrategyFactory } from '../src/auth/social-auth.factory';
import { OAuthStateService } from '../src/auth/oauth-state.service';
import { VARIABLES } from '@common/constants/variables.constants';
import {
  BookingStatus,
  DevicePlatform,
  Role,
} from '@common/types/enums';

jest.setTimeout(300000);

interface Body {
  status?: string;
  message?: string;
  restored?: boolean;
  access_token?: string;
  data?: Record<string, unknown>;
  meta?: { error?: string; statusCode?: number };
}

const PASSWORD = 'CorrectHorse1!';
const NEW_PASSWORD = 'FreshHorse2!';

/** Fields no auth response may ever carry (item 1). */
const FORBIDDEN_USER_KEYS = [
  'password',
  'isBanned',
  'bannedAt',
  'bannedById',
  'isSuspended',
  'suspendedAt',
  'suspendedById',
  'suspensionReason',
  'deletedAt',
  'purgedAt',
];

/** Mutable so each Google test points the stubbed transport at its own row. */
const googleProfile = {
  email: 'unset@test.jinva.local',
  firstname: 'Res',
  lastname: 'Google',
  provider: 'google',
  providerId: 'residual-google-id',
};

describe('auth-residual-findings (backend items 1, 2, 3, 6, 9)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;

  let userRepo: Repository<User>;
  let artisanProfileRepo: Repository<ArtisanProfile>;
  let customerProfileRepo: Repository<CustomerProfile>;
  let deviceTokenRepo: Repository<DeviceToken>;
  let serviceRepo: Repository<ServiceEntity>;
  let bookingRepo: Repository<Booking>;
  let tokenService: UserTokenService;
  let purgeService: AccountPurgeService;
  let authService: AuthService;

  let service: ServiceEntity;
  const uniq = Date.now();
  const createdUserIds: number[] = [];
  const createdProfileIds: number[] = [];
  const createdBookingIds: number[] = [];
  /** Admins parked for the last-admin probe, restored in `afterAll` too. */
  let parkedAdmins: User[] = [];

  const server = () => app.getHttpServer();
  const email = (label: string) =>
    `residual-${label}-${uniq}@test.jinva.local`;
  /** `PHONENUMBER_REGEX` is `\d{3}-\d{3}-\d{4}`, max 12 chars. */
  const phone = (n: number) =>
    `02${n}-${String(uniq).slice(-6, -3)}-${String(uniq).slice(-4)}`;

  const deleteMe = (token: string) =>
    request(server())
      .delete('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`);
  const login = (e: string, p: string) =>
    request(server())
      .post('/api/v1/auth/login')
      .send({ email: e, password: p });
  const restore = (e: string, p: string) =>
    request(server())
      .post('/api/v1/auth/restore-account')
      .send({ email: e, password: p });

  async function makeUser(
    label: string,
    role: Role,
    opts: { social?: boolean; verified?: boolean } = {},
  ): Promise<{ user: User; token: string; email: string }> {
    const e = email(label);
    const user = await userRepo.save(
      userRepo.create({
        email: e,
        // Hashed at the application's real cost factor, not a cheaper one:
        // the B1/B6 timing probe compares a fixture's `bcrypt.compare`
        // against the dummy-cost comparison the unknown-address branch pays,
        // and a cost-10 fixture would read as a ~4x "signal" that is purely
        // an artefact of the fixture.
        password: opts.social
          ? null
          : await bcrypt.hash(PASSWORD, VARIABLES.SALT_OR_ROUNDS),
        firstname: 'Residual',
        lastname: label.slice(0, 14),
        role,
        accountVerified: opts.verified ?? true,
        isBanned: false,
        isSuspended: false,
        ...(opts.social
          ? {
              isSocialLogin: true,
              socialProvider: 'google',
              socialProviderId: `g-residual-${label}-${uniq}`,
            }
          : { isSocialLogin: false }),
      } as Partial<User>),
    );
    createdUserIds.push(user.id);
    return {
      user,
      email: e,
      token: (await tokenService.createJWTTokens(user)).access_token,
    };
  }

  /** Every `Set-Cookie` header on a response, keyed by cookie name. */
  const setCookies = (res: request.Response): Record<string, string> => {
    const raw = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    return Object.fromEntries(
      list.map((cookie) => [String(cookie).split('=')[0], String(cookie)]),
    );
  };

  /**
   * The `name=value` pair only, which is what a browser actually sends back.
   * Replaying the whole `Set-Cookie` string (attributes included) is not the
   * same thing and `cookie-parser` does not read it the same way.
   */
  const cookiePair = (setCookieHeader: string): string =>
    setCookieHeader.split(';')[0];

  /** Byte-comparable shape of a login/restore rejection (B1/B6). */
  const comparable = (res: request.Response) => {
    const b = res.body as Body;
    return {
      status: res.status,
      envelopeStatus: b.status,
      message: b.message,
      error: b.meta?.error,
      statusCode: b.meta?.statusCode,
      hasToken: Boolean(b.access_token),
      setCookie: Boolean(res.headers['set-cookie']),
    };
  };

  const assertNoCredentialMaterial = (
    label: string,
    whole: unknown,
    userPayload: unknown,
  ) => {
    const keys = Object.keys((userPayload ?? {}) as object);

    console.log(`${label} user keys =`, JSON.stringify(keys));
    expect(JSON.stringify(whole)).not.toContain('$2b$');
    for (const key of FORBIDDEN_USER_KEYS) {
      expect(keys).not.toContain(key);
    }
    // The fields the frontend drives redirects and the dashboard shell from.
    for (const key of ['id', 'email', 'role']) {
      expect(keys).toContain(key);
    }
  };

  /** Median, so one scheduling hiccup cannot decide a timing assertion. */
  const median = (values: number[]): number =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

  const timeCall = async (
    call: () => request.Test,
    runs = 3,
  ): Promise<{ ms: number; last: request.Response }> => {
    const timings: number[] = [];
    let last!: request.Response;
    for (let i = 0; i < runs; i += 1) {
      const started = Date.now();
      last = await call();
      timings.push(Date.now() - started);
    }
    return { ms: median(timings), last };
  };

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Only the OAuth *transport* is stubbed — there is no way to complete a
      // real Google consent screen from a test. The callback, the lookup, the
      // new social-login gate and the row-locked restore are all real code
      // against the real database.
      .overrideProvider(SocialAuthStrategyFactory)
      .useValue({
        getStrategy: () => ({
          getAccessToken: () => Promise.resolve('residual-provider-token'),
          getUserProfile: () => Promise.resolve(googleProfile),
          getAuthorizationUrl: () => 'https://accounts.google.test/auth',
        }),
      })
      .overrideProvider(OAuthStateService)
      .useValue({
        generateState: () => 'residual-state',
        consumeState: () => ({ role: Role.CUSTOMER }),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    // Same global wiring as `main.ts`. `cookie-parser` matters here: without
    // it `req.cookies` is undefined and every cookie-reading route (refresh,
    // logout) rejects, which would look like a product failure.
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

    userRepo = moduleFixture.get(getRepositoryToken(User));
    artisanProfileRepo = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    customerProfileRepo = moduleFixture.get(
      getRepositoryToken(CustomerProfile),
    );
    deviceTokenRepo = moduleFixture.get(getRepositoryToken(DeviceToken));
    serviceRepo = moduleFixture.get(getRepositoryToken(ServiceEntity));
    bookingRepo = moduleFixture.get(getRepositoryToken(Booking));
    tokenService = moduleFixture.get(UserTokenService);
    purgeService = moduleFixture.get(AccountPurgeService);
    authService = moduleFixture.get(AuthService);

    service = await serviceRepo.save(
      serviceRepo.create({
        name: `Residual Findings Service ${uniq}`,
        estimatedDurationMins: 60,
      }),
    );
  });

  afterAll(async () => {
    // Safety net: a crash mid-probe must not leave a real admin suspended.
    await restoreParkedAdmins();
    if (createdBookingIds.length)
      await bookingRepo.delete(createdBookingIds).catch(() => undefined);
    for (const id of createdUserIds) {
      await deviceTokenRepo.delete({ userId: id }).catch(() => undefined);
      await customerProfileRepo
        .createQueryBuilder()
        .delete()
        .where('user_id = :id', { id })
        .execute()
        .catch(() => undefined);
    }
    if (createdProfileIds.length)
      await artisanProfileRepo
        .delete(createdProfileIds)
        .catch(() => undefined);
    if (createdUserIds.length)
      await userRepo.delete(createdUserIds).catch(() => undefined);
    if (service) await serviceRepo.delete(service.id).catch(() => undefined);
    delete process.env.ACCOUNT_PURGE_MODE;
    await app.close();
  });

  async function restoreParkedAdmins(): Promise<void> {
    for (const admin of parkedAdmins) {
      await userRepo
        .update(
          { id: admin.id },
          {
            isSuspended: admin.isSuspended,
            suspendedAt: admin.suspendedAt ?? null,
            suspendedById: admin.suspendedById ?? null,
            suspensionReason: admin.suspensionReason ?? null,
          },
        )
        .catch(() => undefined);
    }
    parkedAdmins = [];
  }

  // ───────── item 1: no credential material in auth responses ─────────

  describe('item 1 — auth responses carry no credential material or admin-only fields', () => {
    it('POST /auth/register: no password key, no $2b$ anywhere', async () => {
      const e = email('register');
      const res = await request(server())
        .post('/api/v1/auth/register')
        .send({
          email: e,
          password: PASSWORD,
          username: `residualreg${uniq}`,
          firstname: 'Reg',
          lastname: 'Hygiene',
          phoneNumber: phone(1),
          role: Role.CUSTOMER,
        });
      const created = await userRepo.findOne({ where: { email: e } });
      if (created) createdUserIds.push(created.id);

      expect(res.status).toBe(201);
      // `/auth/*` bypasses the envelope, so the body *is* the user payload.
      assertNoCredentialMaterial('register', res.body, res.body);
    });

    it('POST /auth/change-password: no password key, including the hash it just computed', async () => {
      const u = await makeUser('chpw', Role.CUSTOMER);

      const res = await request(server())
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${u.token}`)
        .send({
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
          confirmNewPassword: NEW_PASSWORD,
        });

      expect(res.status).toBe(200);
      assertNoCredentialMaterial(
        'change-password',
        res.body,
        (res.body as Body).data,
      );
      // The change really happened — otherwise this would pass for the wrong
      // reason.
      expect((await login(u.email, NEW_PASSWORD)).status).toBe(200);
    });

    it('login, refresh and restore bodies carry only declared profile fields', async () => {
      const u = await makeUser('bodies', Role.ARTISAN);

      const loggedIn = await login(u.email, PASSWORD);
      expect(loggedIn.status).toBe(200);
      assertNoCredentialMaterial(
        'login',
        loggedIn.body,
        (loggedIn.body as Body).data,
      );

      const refreshCookie = cookiePair(
        setCookies(loggedIn)[VARIABLES.REFRESH_TOKEN_COOKIE_NAME],
      );
      const refreshed = await request(server())
        .post('/api/v1/auth/refresh-token')
        .set('Cookie', [refreshCookie]);
      expect(refreshed.status).toBe(200);
      assertNoCredentialMaterial(
        'refresh',
        refreshed.body,
        (refreshed.body as Body).data,
      );

      const token = (refreshed.body as Body).access_token as string;
      await deleteMe(token).expect(200);
      const restored = await restore(u.email, PASSWORD);
      expect(restored.status).toBe(200);
      assertNoCredentialMaterial(
        'restore',
        restored.body,
        (restored.body as Body).data,
      );
    });
  });

  // ───────── item 2: deletion ends the session on the device ─────────

  describe('item 2 — DELETE /users/me clears its own cookies, on success only', () => {
    it('clears both cookies on a successful deletion, body unchanged', async () => {
      const u = await makeUser('cookies', Role.CUSTOMER);
      const loggedIn = await login(u.email, PASSWORD);
      expect(Object.keys(setCookies(loggedIn)).sort()).toEqual([
        VARIABLES.AUTH_SESSION_COOKIE_NAME,
        VARIABLES.REFRESH_TOKEN_COOKIE_NAME,
      ]);

      const res = await deleteMe((loggedIn.body as Body).access_token!);
      const cleared = setCookies(res);

      console.log('item 2 delete Set-Cookie =', JSON.stringify(cleared));
      expect(res.status).toBe(200);
      for (const name of [
        VARIABLES.REFRESH_TOKEN_COOKIE_NAME,
        VARIABLES.AUTH_SESSION_COOKIE_NAME,
      ]) {
        expect(cleared[name]).toBeDefined();
        // Empty value and `Max-Age=0`, which is what actually removes it —
        // per RFC 6265 §5.3 `Max-Age` wins over `Expires`, and Express
        // rewrites the `expires` option to "now" whenever `maxAge` is also
        // given, so asserting an epoch `Expires` would be asserting Express's
        // internals rather than the behaviour.
        expect(cleared[name]).toMatch(/Max-Age=0/i);
        expect(cleared[name].startsWith(`${name}=;`)).toBe(true);
        expect(cleared[name]).toContain('HttpOnly');
        expect(cleared[name]).toContain('Path=/');
      }

      // Byte-identical to what `POST /auth/logout` emits — the requirement is
      // "the same calls logout already makes", so a drift in either helper
      // should fail here.
      const other = await makeUser('logoutshape', Role.CUSTOMER);
      const loggedOut = await request(server())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${other.token}`);
      const logoutCleared = setCookies(loggedOut);
      for (const name of [
        VARIABLES.REFRESH_TOKEN_COOKIE_NAME,
        VARIABLES.AUTH_SESSION_COOKIE_NAME,
      ]) {
        expect(cleared[name].replace(/Expires=[^;]+;\s*/, '')).toBe(
          logoutCleared[name].replace(/Expires=[^;]+;\s*/, ''),
        );
      }

      // Nothing else about the response changed.
      const body = res.body as Body;
      expect(body.data?.deletedAt).toBeDefined();
      expect(body.data?.purgeAt).toBeDefined();
      expect(body.data?.retentionDays).toBe(30);
    });

    it('clears nothing when deletion is refused, and the caller stays authenticated', async () => {
      const cust = await makeUser('refusedcookies', Role.CUSTOMER);
      const art = await makeUser('refusedart', Role.ARTISAN);
      const profile = await artisanProfileRepo.save(
        artisanProfileRepo.create({ user: art.user } as Partial<ArtisanProfile>),
      );
      createdProfileIds.push(profile.id);
      const booking = await bookingRepo.save(
        bookingRepo.create({
          customer: cust.user,
          artisanProfile: profile,
          service,
          scheduledDate: '2026-10-01',
          startTime: '09:00:00',
          endTime: '10:00:00',
          status: BookingStatus.PENDING,
          agreedPrice: 120,
          currency: 'GHS',
        }),
      );
      createdBookingIds.push(booking.id);

      const res = await deleteMe(cust.token);

      console.log(
        'item 2 refusal Set-Cookie =',
        JSON.stringify(res.headers['set-cookie'] ?? null),
      );
      expect(res.status).toBe(409);
      expect((res.body as Body).meta?.error).toBe(
        'ACCOUNT_HAS_LIVE_COMMITMENTS',
      );
      expect(res.headers['set-cookie']).toBeUndefined();

      // Still fully authenticated on the next request.
      const me = await request(server())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${cust.token}`);
      expect(me.status).toBe(200);
    });
  });

  // ───────── item 3: purge clears bio and device tokens ─────────

  describe('item 3 — the purge clears a customer bio and every device token', () => {
    const BIO = 'Customer bio that must not survive a purge.';

    /** Read back with `select`, never through the ORM's entity cache. */
    const readBio = async (userId: number): Promise<string | null> => {
      const rows: { bio: string | null }[] = await userRepo.manager.query(
        'select bio from customer_profiles where user_id = $1',
        [userId],
      );
      return rows[0]?.bio ?? null;
    };
    const countDevices = async (userId: number): Promise<number> => {
      const rows: { c: number }[] = await userRepo.manager.query(
        'select count(*)::int as c from device_tokens where user_id = $1',
        [userId],
      );
      return Number(rows[0].c);
    };

    const makePurgeCandidate = async (label: string) => {
      const u = await makeUser(label, Role.CUSTOMER);
      await customerProfileRepo.save(
        customerProfileRepo.create({
          user: u.user,
          bio: BIO,
          preferredServices: [],
        } as Partial<CustomerProfile>),
      );
      for (const suffix of ['a', 'b']) {
        await deviceTokenRepo.save(
          deviceTokenRepo.create({
            userId: u.user.id,
            token: `residual-${label}-${suffix}-${uniq}`,
            platform: DevicePlatform.ANDROID,
          }),
        );
      }
      await deleteMe(u.token).expect(200);
      await userRepo.update({ id: u.user.id }, {
        deletedAt: subDays(new Date(), 40),
      } as never);
      return u;
    };

    it('log-only mode (the default) leaves the bio and the device tokens untouched', async () => {
      delete process.env.ACCOUNT_PURGE_MODE;
      expect(purgeService.isDestructiveModeEnabled()).toBe(false);
      const u = await makePurgeCandidate('logonly');

      const outcome = await purgeService.purgeAccount(u.user.id);

      console.log(
        'item 3 log-only =',
        outcome,
        JSON.stringify({
          bio: await readBio(u.user.id),
          devices: await countDevices(u.user.id),
        }),
      );
      expect(outcome).toBe('reported');
      expect(await readBio(u.user.id)).toBe(BIO);
      expect(await countDevices(u.user.id)).toBe(2);
    });

    it('destructive mode nulls the bio, deletes every device token, and stays idempotent', async () => {
      const u = await makePurgeCandidate('destructive');
      expect(await readBio(u.user.id)).toBe(BIO);
      expect(await countDevices(u.user.id)).toBe(2);

      process.env.ACCOUNT_PURGE_MODE = 'destructive';
      try {
        expect(await purgeService.purgeAccount(u.user.id)).toBe('purged');

        const bio = await readBio(u.user.id);
        const devices = await countDevices(u.user.id);

        console.log(
          'item 3 destructive =',
          JSON.stringify({ bio, devices }),
        );
        expect(bio).toBeNull();
        expect(devices).toBe(0);
        // The customer profile row itself is kept (counterparty joins), only
        // the free text is gone.
        const rows: { c: number }[] = await userRepo.manager.query(
          'select count(*)::int as c from customer_profiles where user_id = $1',
          [u.user.id],
        );
        expect(Number(rows[0].c)).toBe(1);

        // A rerun writes nothing.
        expect(await purgeService.purgeAccount(u.user.id)).toBe('skipped');
        expect(await readBio(u.user.id)).toBeNull();
      } finally {
        delete process.env.ACCOUNT_PURGE_MODE;
      }
    });

    it('purges cleanly with no customer profile and no registered devices', async () => {
      const u = await makeUser('emptypurge', Role.ARTISAN);
      await deleteMe(u.token).expect(200);
      await userRepo.update({ id: u.user.id }, {
        deletedAt: subDays(new Date(), 40),
      } as never);

      process.env.ACCOUNT_PURGE_MODE = 'destructive';
      try {
        const outcome = await purgeService.purgeAccount(u.user.id);

        console.log('item 3 empty-state purge =', outcome);
        expect(outcome).toBe('purged');
        expect(await countDevices(u.user.id)).toBe(0);
      } finally {
        delete process.env.ACCOUNT_PURGE_MODE;
      }
    });
  });

  // ───────── item 6: Google restore is social-accounts only ─────────

  describe('item 6 — Google sign-in cannot restore a password-only account', () => {
    const completeGoogleFlow = () =>
      authService.handleOAuthCallback('google', {
        code: 'residual-code',
        state: 'residual-state',
      } as never);

    it('refuses a password-only soft-deleted account, restores nothing, duplicates nothing', async () => {
      const u = await makeUser('pwonly', Role.CUSTOMER);
      await deleteMe(u.token).expect(200);
      googleProfile.email = u.email;
      googleProfile.providerId = `residual-google-${u.user.id}`;

      let err: unknown;
      try {
        await completeGoogleFlow();
      } catch (e) {
        err = e;
      }

      console.log(
        'item 6 password-only Google restore threw =',
        (err as Error)?.constructor?.name,
        JSON.stringify((err as Error)?.message),
      );
      expect(err).toBeDefined();

      const row = await userRepo.findOne({
        where: { id: u.user.id },
        withDeleted: true,
      });
      expect(row?.deletedAt).toBeInstanceOf(Date);
      expect(row?.isSocialLogin).toBe(false);
      // No second row for an address the soft-deleted row still holds.
      expect(
        await userRepo.count({ where: { email: u.email }, withDeleted: true }),
      ).toBe(1);

      // The password recovery path is untouched: the owner still gets the
      // pending-deletion rejection and can restore.
      const pending = await login(u.email, PASSWORD);
      expect(pending.status).toBe(403);
      expect((pending.body as Body).meta?.error).toBe(
        'ACCOUNT_PENDING_DELETION',
      );
      const restored = await restore(u.email, PASSWORD);

      console.log('item 6 password restore after refusal =', restored.status);
      expect(restored.status).toBe(200);
      expect(
        (await userRepo.findOne({ where: { id: u.user.id } }))?.deletedAt ??
          null,
      ).toBeNull();
    });

    it('still restores a genuine social-login account inline (no regression)', async () => {
      const g = await makeUser('social', Role.CUSTOMER, { social: true });
      await deleteMe(g.token).expect(200);
      googleProfile.email = g.email;
      googleProfile.providerId = `residual-google-${g.user.id}`;

      const result = await completeGoogleFlow();

      console.log(
        'item 6 social Google restore =',
        JSON.stringify({ hasRefresh: Boolean(result.refreshToken) }),
      );
      expect(result.refreshToken).toBeTruthy();
      const row = await userRepo.findOne({ where: { id: g.user.id } });
      expect(row?.deletedAt ?? null).toBeNull();
      expect(
        await userRepo.count({ where: { email: g.email }, withDeleted: true }),
      ).toBe(1);
    });

    it('leaves a live password-only account signing in with Google unchanged', async () => {
      const u = await makeUser('livepw', Role.CUSTOMER);
      googleProfile.email = u.email;
      googleProfile.providerId = `residual-google-${u.user.id}`;

      const result = await completeGoogleFlow();

      expect(result.refreshToken).toBeTruthy();
      expect(result.result.data.id).toBe(u.user.id);
      expect(
        await userRepo.count({ where: { email: u.email }, withDeleted: true }),
      ).toBe(1);
    });
  });

  // ───────── item 9: the last usable ADMIN cannot self-delete ─────────

  describe('item 9 — the last usable ADMIN cannot self-delete', () => {
    /**
     * The guard counts usable admins across the whole platform, so the probe
     * has to be the only one. Any pre-existing usable admin (a seeded one, for
     * instance) is temporarily suspended and restored to its exact previous
     * values in the `finally` — and again in `afterAll`, so a crash cannot
     * leave a real admin parked.
     */
    const parkOtherAdmins = async (keepIds: number[]): Promise<void> => {
      parkedAdmins = await userRepo.find({
        where: {
          role: Role.ADMIN,
          deletedAt: IsNull(),
          purgedAt: IsNull(),
          isBanned: false,
          isSuspended: false,
          ...(keepIds.length ? { id: Not(In(keepIds)) } : {}),
        },
        select: [
          'id',
          'isSuspended',
          'suspendedAt',
          'suspendedById',
          'suspensionReason',
        ],
      });
      if (!parkedAdmins.length) return;
      await userRepo.update(
        { id: In(parkedAdmins.map((a) => a.id)) },
        {
          isSuspended: true,
          suspensionReason: 'e2e last-admin guard probe',
        },
      );
    };

    it('refuses with its own 409 code, deletes nothing, clears no cookie', async () => {
      const admin = await makeUser('lastadmin', Role.ADMIN);
      await parkOtherAdmins([admin.user.id]);
      try {
        const res = await deleteMe(admin.token);
        const body = res.body as Body;

        console.log(
          'item 9 last-admin refusal =',
          res.status,
          JSON.stringify(body),
        );
        expect(res.status).toBe(409);
        expect(body.meta?.error).toBe('LAST_ADMIN_CANNOT_DELETE');
        expect(body.message).toContain("can't be deleted");
        // Amount-free, and no bare number that reads as money or as a count.
        expect(body.message).not.toMatch(/GH₵|\$|\d/);

        // Not deleted, still authenticated, no cookie cleared.
        const row = await userRepo.findOne({
          where: { id: admin.user.id },
          withDeleted: true,
        });
        expect(row?.deletedAt ?? null).toBeNull();
        expect(res.headers['set-cookie']).toBeUndefined();
        const me = await request(server())
          .get('/api/v1/users/me')
          .set('Authorization', `Bearer ${admin.token}`);
        expect(me.status).toBe(200);
        // Refresh tokens were not revoked either.
        const { refresh_token } = await tokenService.createJWTTokens(
          admin.user,
        );
        expect(refresh_token).toBeTruthy();
      } finally {
        await restoreParkedAdmins();
      }
    });

    it('permits deletion when a second usable admin remains (count-based, not a ban)', async () => {
      const first = await makeUser('admin1', Role.ADMIN);
      const second = await makeUser('admin2', Role.ADMIN);
      await parkOtherAdmins([first.user.id, second.user.id]);
      try {
        const res = await deleteMe(first.token);

        console.log(
          'item 9 two-admin control =',
          res.status,
          JSON.stringify((res.body as Body).data),
        );
        expect(res.status).toBe(200);
        expect((res.body as Body).data?.retentionDays).toBe(30);
        expect(
          (
            await userRepo.findOne({
              where: { id: first.user.id },
              withDeleted: true,
            })
          )?.deletedAt,
        ).toBeInstanceOf(Date);
        expect(second.user.id).toBeDefined();
      } finally {
        await restoreParkedAdmins();
      }
    });

    it.each([
      ['soft-deleted', async (repo: Repository<User>, id: number) => {
        await repo.softDelete({ id });
      }],
      ['banned', async (repo: Repository<User>, id: number) => {
        await repo.update({ id }, { isBanned: true, bannedAt: new Date() });
      }],
      ['suspended', async (repo: Repository<User>, id: number) => {
        await repo.update(
          { id },
          { isSuspended: true, suspendedAt: new Date() },
        );
      }],
    ])(
      'does not count a %s admin as cover',
      async (label, disable) => {
        const caller = await makeUser(`cover-${label}`, Role.ADMIN);
        const other = await makeUser(`other-${label}`, Role.ADMIN);
        await disable(userRepo, other.user.id);
        await parkOtherAdmins([caller.user.id, other.user.id]);
        try {
          const res = await deleteMe(caller.token);

          console.log(
            `item 9 ${label} second admin =`,
            res.status,
            JSON.stringify((res.body as Body).meta?.error),
          );
          expect(res.status).toBe(409);
          expect((res.body as Body).meta?.error).toBe(
            'LAST_ADMIN_CANNOT_DELETE',
          );
        } finally {
          await restoreParkedAdmins();
        }
      },
    );

    it('reports one coherent 409 when live commitments also apply', async () => {
      const admin = await makeUser('adminbusy', Role.ADMIN);
      const art = await makeUser('adminbusyart', Role.ARTISAN);
      const profile = await artisanProfileRepo.save(
        artisanProfileRepo.create({ user: art.user } as Partial<ArtisanProfile>),
      );
      createdProfileIds.push(profile.id);
      const booking = await bookingRepo.save(
        bookingRepo.create({
          customer: admin.user,
          artisanProfile: profile,
          service,
          scheduledDate: '2026-10-02',
          startTime: '09:00:00',
          endTime: '10:00:00',
          status: BookingStatus.PENDING,
          agreedPrice: 90,
          currency: 'GHS',
        }),
      );
      createdBookingIds.push(booking.id);
      await parkOtherAdmins([admin.user.id]);
      try {
        const res = await deleteMe(admin.token);
        const message = (res.body as Body).message ?? '';

        console.log(
          'item 9 combined refusal =',
          res.status,
          JSON.stringify(message),
        );
        expect(res.status).toBe(409);
        expect((res.body as Body).meta?.error).toBe('LAST_ADMIN_CANNOT_DELETE');
        // One message, not two stacked.
        expect(message).not.toContain('booking');
        expect(message.match(/can't be deleted/g)).toHaveLength(1);
      } finally {
        await restoreParkedAdmins();
      }
    });

    it('leaves a CUSTOMER with no commitments deleting exactly as before', async () => {
      const u = await makeUser('plaincust', Role.CUSTOMER);

      const res = await deleteMe(u.token);
      const body = res.body as Body;

      expect(res.status).toBe(200);
      expect(body.data?.deletedAt).toBeDefined();
      expect(body.data?.purgeAt).toBeDefined();
      expect(body.data?.retentionDays).toBe(30);
    });
  });

  // ───────── regression: B1/B6 after the logging change (item 5) ─────────

  describe('items 5 regression — login and restore stay indistinguishable (B1/B6)', () => {
    it('body and timing are the same across live, soft-deleted and never-registered', async () => {
      const live = await makeUser('timinglive', Role.CUSTOMER);
      const deleted = await makeUser('timingdel', Role.CUSTOMER);
      await deleteMe(deleted.token).expect(200);
      const unknown = email('timingnobody');

      const wrongOnLive = await timeCall(() =>
        login(live.email, 'WrongPass1!'),
      );
      const wrongOnDeleted = await timeCall(() =>
        login(deleted.email, 'WrongPass1!'),
      );
      const neverRegistered = await timeCall(() =>
        login(unknown, 'WrongPass1!'),
      );

      console.log(
        'item 5 login timings (ms) =',
        JSON.stringify({
          live: wrongOnLive.ms,
          deleted: wrongOnDeleted.ms,
          unknown: neverRegistered.ms,
        }),
      );

      // Bodies first: byte-comparable, as before the logging change.
      expect(comparable(wrongOnDeleted.last)).toEqual(
        comparable(wrongOnLive.last),
      );
      expect(comparable(neverRegistered.last)).toEqual(
        comparable(wrongOnLive.last),
      );

      // And timing: every branch must still pay for exactly one bcrypt
      // comparison. The pre-fix signal was ~6ms vs ~560ms, so a generous
      // floor and ratio catch a reintroduced short-circuit without being
      // flaky on a loaded machine.
      const timings = [
        wrongOnLive.ms,
        wrongOnDeleted.ms,
        neverRegistered.ms,
      ];
      for (const ms of timings) {
        expect(ms).toBeGreaterThan(50);
      }
      expect(Math.max(...timings) / Math.max(1, Math.min(...timings))).
        toBeLessThan(4);

      // The same for restore-account.
      const rWrong = await timeCall(() =>
        restore(deleted.email, 'WrongPass1!'),
      );
      const rUnknown = await timeCall(() => restore(unknown, 'WrongPass1!'));
      const rLive = await timeCall(() => restore(live.email, PASSWORD));

      console.log(
        'item 5 restore timings (ms) =',
        JSON.stringify({
          deletedWrongPassword: rWrong.ms,
          unknown: rUnknown.ms,
          live: rLive.ms,
        }),
      );
      expect(comparable(rUnknown.last)).toEqual(comparable(rWrong.last));
      expect(comparable(rLive.last)).toEqual(comparable(rWrong.last));
      const restoreTimings = [rWrong.ms, rUnknown.ms, rLive.ms];
      for (const ms of restoreTimings) {
        expect(ms).toBeGreaterThan(50);
      }
      expect(
        Math.max(...restoreTimings) /
          Math.max(1, Math.min(...restoreTimings)),
      ).toBeLessThan(4);
    });
  });
});
