/**
 * QA re-verification for `docs/team/auth-residual-findings/requirements.md`
 * items 1, 2, 6 and 9, plus the round-3 regression set (B1/B2/B3/B6), against a
 * real database and production's global wiring.
 *
 * Test code only — written by QA. Nothing here is imported by the application.
 * This file deliberately re-runs the ORIGINAL repros from
 * `auth-settings-closeout/qa-report.md` and `security-report.md` rather than
 * re-asserting the build engineers' own spec, so the evidence is independent.
 *
 * Run: npm run test:e2e -- auth-residual-r4.qa
 */
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '10000';
process.env.AUTH_EMAIL_RATE_LIMIT_PER_MINUTE = '10000';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { IsNull, Not, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import * as bcrypt from 'bcrypt';
import { subDays } from 'date-fns';
import * as fs from 'fs';
import cookieParser from 'cookie-parser';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { Job } from '@jobs/entities/job.entity';
import { UserTokenService } from '@users/token.service';
import { SocialAuthStrategyFactory } from '../src/auth/social-auth.factory';
import { OAuthStateService } from '../src/auth/oauth-state.service';
import { Role, Status } from '@common/types/enums';
import { VARIABLES } from '@common/constants/variables.constants';

jest.setTimeout(600000);

interface Body {
  status?: string;
  message?: string;
  restored?: boolean;
  requiresEmailVerification?: boolean;
  access_token?: string;
  password?: string;
  data?: Record<string, unknown>;
  meta?: {
    error?: string;
    statusCode?: number;
    details?: Record<string, unknown>;
  };
}

const PASSWORD = 'CorrectHorse1!';
const NEW_PASSWORD = 'CorrectHorse2!';

/** Fields the round says must never appear on an auth response again. */
const FORBIDDEN_FIELDS = [
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

/** The exact field set `UserResponseDto` declares. */
const DECLARED_FIELDS = [
  'id',
  'email',
  'username',
  'firstname',
  'lastname',
  'gender',
  'role',
  'phoneNumber',
  'profilePicture',
  'accountVerified',
  'addresses',
];

const googleProfile: {
  email: string;
  firstname: string;
  lastname: string;
  provider: string;
  providerId: string;
} = {
  email: 'unset@test.jinva.local',
  firstname: 'Qa',
  lastname: 'Google',
  provider: 'google',
  providerId: 'qa-r4-google-id',
};

const SNAPSHOT = `${__dirname}/../../r4-admin-restore-snapshot.json`;

describe('auth-residual-findings round 4 (QA e2e)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let userRepo: Repository<User>;
  let profileRepo: Repository<ArtisanProfile>;
  let serviceRepo: Repository<ServiceEntity>;
  let jobRepo: Repository<Job>;
  let tokenService: UserTokenService;

  let service: ServiceEntity;
  const uniq = Date.now();
  const createdUserIds: number[] = [];
  const createdProfileIds: number[] = [];
  const createdJobIds: number[] = [];

  /** Pre-existing ADMIN rows, captured so item 9 can put them back exactly. */
  let adminSnapshot: Array<Record<string, unknown>> = [];

  const server = () => app.getHttpServer();
  const email = (label: string) => `qa-r4-${label}-${uniq}@test.jinva.local`;

  const login = (e: string, p: string) =>
    request(server())
      .post('/api/v1/auth/login')
      .send({ email: e, password: p });
  const restore = (e: string, p: string) =>
    request(server())
      .post('/api/v1/auth/restore-account')
      .send({ email: e, password: p });
  const deleteMe = (token: string) =>
    request(server())
      .delete('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`);
  const me = (token: string) =>
    request(server())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`);

  async function makeUser(
    label: string,
    role: Role,
    opts: { verified?: boolean; social?: boolean; noPassword?: boolean } = {},
  ): Promise<{ user: User; token: string; email: string }> {
    const e = email(label);
    const user = await userRepo.save(
      userRepo.create({
        email: e,
        // The application's own cost factor, deliberately: a fixture hashed at
        // a lower cost would verify ~4x faster than a real account and would
        // fake a timing separation in the B1/B6 probes.
        password: opts.noPassword
          ? null
          : await bcrypt.hash(PASSWORD, VARIABLES.SALT_OR_ROUNDS),
        firstname: 'QaR4',
        lastname: label.slice(0, 14),
        phoneNumber: `024${String(uniq).slice(-7)}${createdUserIds.length}`,
        role,
        accountVerified: opts.verified ?? true,
        isBanned: false,
        isSuspended: false,
        ...(opts.social
          ? {
              isSocialLogin: true,
              socialProvider: 'google',
              socialProviderId: `g-r4-${label}-${uniq}`,
            }
          : {}),
      } as Partial<User>),
    );
    createdUserIds.push(user.id);
    return {
      user,
      email: e,
      token: (await tokenService.createJWTTokens(user)).access_token,
    };
  }

  /** Soft-delete a row directly and age it, without going through the API. */
  async function softDelete(id: number, daysAgo = 1): Promise<void> {
    await userRepo.manager.query(
      'update users set deleted_at = $2 where id = $1',
      [id, subDays(new Date(), daysAgo)],
    );
  }

  const setCookieHeader = (res: request.Response): string[] => {
    const raw = res.headers['set-cookie'];
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
  };

  const cookieNames = (res: request.Response): string[] =>
    setCookieHeader(res).map((c) => c.split('=')[0]);

  /** Byte-comparable shape of a login/restore rejection (B1/B6). */
  const comparable = (res: request.Response) => {
    const b = res.body as Body;
    return {
      status: res.status,
      envelopeStatus: b.status,
      message: b.message,
      error: b.meta?.error,
      statusCode: b.meta?.statusCode,
      details: b.meta?.details ?? null,
      hasToken: Boolean(b.access_token),
      setCookie: Boolean(res.headers['set-cookie']),
    };
  };

  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  /** Assert a serialised user object is exactly the declared field set. */
  function assertCleanUserObject(label: string, data: unknown): void {
    expect(data).toBeTruthy();
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);
    console.log(`[item1] ${label} user keys =`, JSON.stringify(keys));
    for (const f of FORBIDDEN_FIELDS) {
      expect(keys).not.toContain(f);
    }
    // Nothing undeclared survived the tightening.
    expect(keys.filter((k) => !DECLARED_FIELDS.includes(k))).toEqual([]);
    // The two fields the frontend's redirect + dashboard shell depend on.
    expect(obj.id).toBeDefined();
    expect(obj.role).toBeDefined();
    expect(obj.email).toBeDefined();
    // No bcrypt hash anywhere in the object, under any key.
    expect(JSON.stringify(obj)).not.toContain('$2b$');
    expect(JSON.stringify(obj)).not.toContain('$2a$');
  }

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      // Only the OAuth transport is stubbed — there is no way to complete a
      // real Google consent screen from a test. Everything the restore
      // decision depends on (UsersService, the row lock, the real database) is
      // untouched.
      .overrideProvider(SocialAuthStrategyFactory)
      .useValue({
        getStrategy: () => ({
          getAccessToken: () => Promise.resolve('qa-r4-provider-token'),
          getUserProfile: () => Promise.resolve(googleProfile),
          generateAuthUrl: () => 'https://accounts.google.test/auth',
        }),
      })
      .overrideProvider(OAuthStateService)
      .useValue({
        createState: () => 'qa-r4-state',
        consumeState: () => ({ role: Role.CUSTOMER }),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    const logger = app.get<WinstonLogger>(WINSTON_MODULE_NEST_PROVIDER);
    app.useGlobalFilters(new AllExceptionsFilter(logger), new TypeOrmFilter());
    // Same order main.ts uses — without it `req.cookies` is undefined and
    // every cookie-reading route (refresh-token, logout) 400s for harness
    // reasons that have nothing to do with the code under test.
    app.use(cookieParser());
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
    profileRepo = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    serviceRepo = moduleFixture.get(getRepositoryToken(ServiceEntity));
    jobRepo = moduleFixture.get(getRepositoryToken(Job));
    tokenService = moduleFixture.get(UserTokenService);

    service = await serviceRepo.save(
      serviceRepo.create({
        name: `QA R4 Service ${uniq}`,
        estimatedDurationMins: 60,
      }),
    );

    // Safety net for item 9 — see the L4 block below.
    adminSnapshot = await userRepo.manager.query(
      `select id, is_banned, banned_at, banned_by_id, is_suspended, suspended_at,
              suspended_by_id, suspension_reason, deleted_at, purged_at
         from users where role = 'ADMIN' order by id`,
    );
    fs.writeFileSync(SNAPSHOT, JSON.stringify(adminSnapshot, null, 1));
    console.log(
      '[item9] pre-existing ADMIN ids snapshotted =',
      adminSnapshot.map((a) => a.id).join(','),
    );
  });

  /** Puts every pre-existing ADMIN row back to its exact captured state. */
  async function restoreAdminSnapshot(): Promise<void> {
    for (const a of adminSnapshot) {
      await userRepo.manager.query(
        `update users set is_banned=$2, banned_at=$3, banned_by_id=$4,
                          is_suspended=$5, suspended_at=$6, suspended_by_id=$7,
                          suspension_reason=$8, deleted_at=$9, purged_at=$10
           where id=$1`,
        [
          a.id,
          a.is_banned,
          a.banned_at,
          a.banned_by_id,
          a.is_suspended,
          a.suspended_at,
          a.suspended_by_id,
          a.suspension_reason,
          a.deleted_at,
          a.purged_at,
        ],
      );
    }
  }

  afterAll(async () => {
    await restoreAdminSnapshot();
    const left: { c: number }[] = await userRepo.manager.query(
      `select count(*)::int c from users
        where role='ADMIN' and deleted_at is null and purged_at is null
          and is_banned=false and is_suspended=false`,
    );
    console.log('[item9] usable ADMIN rows after cleanup =', left[0].c);

    if (createdJobIds.length)
      await jobRepo.delete(createdJobIds).catch(() => undefined);
    if (createdProfileIds.length)
      await profileRepo.delete(createdProfileIds).catch(() => undefined);
    for (const id of createdUserIds) {
      await userRepo.manager
        .query('delete from user_tokens where user_id = $1', [id])
        .catch(() => undefined);
    }
    if (createdUserIds.length)
      await userRepo.manager
        .query('delete from users where id = any($1::int[])', [createdUserIds])
        .catch(() => undefined);
    if (service) await serviceRepo.delete(service.id).catch(() => undefined);
    fs.rmSync(SNAPSHOT, { force: true });
    await app.close();
  });

  // ════════════════ Item 1 (qa B5 / security L3) ════════════════

  describe('item 1 — no credential material or admin-only fields in auth responses', () => {
    it('B5 original repro: POST /auth/register 201 carries no password key and no $2b$ string', async () => {
      const e = email('reg');
      const res = await request(server())
        .post('/api/v1/auth/register')
        .send({
          email: e,
          password: PASSWORD,
          username: `qar4reg${uniq}`,
          firstname: 'QaR4',
          lastname: 'Register',
          role: Role.CUSTOMER,
        });

      console.log('[item1] register status =', res.status);
      console.log('[item1] register raw body =', JSON.stringify(res.body));
      expect(res.status).toBe(201);

      const created = await userRepo.findOne({
        where: { email: e },
        withDeleted: true,
      });
      if (created) createdUserIds.push(created.id);

      const whole = JSON.stringify(res.body);
      expect(whole).not.toContain('$2b$');
      expect(whole).not.toContain('$2a$');
      expect(whole).not.toContain('"password"');
      // `POST /auth/register` is outside the ResponseInterceptor and returns
      // the serialised user object as the whole body — there is no `data`
      // envelope on this one endpoint.
      assertCleanUserObject('register', res.body);
    });

    it('the call site QA never tested: POST /auth/change-password carries no password key', async () => {
      const u = await makeUser('chpw', Role.CUSTOMER);
      const res = await request(server())
        .post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${u.token}`)
        .send({
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
          confirmNewPassword: NEW_PASSWORD,
        });

      console.log('[item1] change-password status =', res.status);
      console.log(
        '[item1] change-password raw body =',
        JSON.stringify(res.body),
      );
      expect(res.status).toBe(200);

      const whole = JSON.stringify(res.body);
      expect(whole).not.toContain('$2b$');
      expect(whole).not.toContain('$2a$');
      expect(whole).not.toContain('"password"');
      assertCleanUserObject('change-password', (res.body as Body).data);

      // …and the change actually took effect (the tightening must not have
      // broken the endpoint it is serialising).
      const oldPw = await login(u.email, PASSWORD);
      const newPw = await login(u.email, NEW_PASSWORD);
      console.log(
        '[item1] after change-password: old pw =',
        oldPw.status,
        '/ new pw =',
        newPw.status,
      );
      expect(oldPw.status).toBe(401);
      expect(newPw.status).toBe(200);
    });

    it('login, refresh-token, restore (session + verify-email) and Google login all serialise the same clean set', async () => {
      // login
      const u = await makeUser('ser', Role.ARTISAN);
      const lr = await login(u.email, PASSWORD);
      expect(lr.status).toBe(200);
      assertCleanUserObject('login', (lr.body as Body).data);
      expect(JSON.stringify(lr.body)).not.toContain('"password"');

      // refresh-token (needs the refresh cookie login just set)
      const refreshCookie = setCookieHeader(lr).find((c) =>
        c.startsWith('refresh_token='),
      );
      expect(refreshCookie).toBeTruthy();
      // Send back only the name=value pair, the way a browser would — not the
      // whole Set-Cookie line with its attributes.
      const rr = await request(server())
        .post('/api/v1/auth/refresh-token')
        .set('Cookie', (refreshCookie as string).split(';')[0]);
      console.log('[item1] refresh-token status =', rr.status);
      expect(rr.status).toBe(200);
      assertCleanUserObject('refresh-token', (rr.body as Body).data);

      // restore — verified account, session variant
      const v = await makeUser('resS', Role.CUSTOMER, { verified: true });
      await softDelete(v.user.id);
      const rs = await restore(v.email, PASSWORD);
      console.log('[item1] restore(session) status =', rs.status);
      expect(rs.status).toBe(200);
      expect((rs.body as Body).restored).toBe(true);
      assertCleanUserObject('restore-session', (rs.body as Body).data);

      // restore — unverified account, verify-email variant
      const n = await makeUser('resV', Role.CUSTOMER, { verified: false });
      await softDelete(n.user.id);
      const rv = await restore(n.email, PASSWORD);
      console.log('[item1] restore(verify-email) status =', rv.status);
      expect(rv.status).toBe(200);
      expect((rv.body as Body).requiresEmailVerification).toBe(true);
      assertCleanUserObject('restore-verify-email', (rv.body as Body).data);

      // Google/social login on a live account
      const g = await makeUser('soc', Role.CUSTOMER, { social: true });
      googleProfile.email = g.email;
      googleProfile.providerId = `g-r4-soc-${uniq}`;
      const gr = await request(server()).get(
        '/api/v1/auth/google/callback?code=qa&state=qa-r4-state',
      );
      console.log(
        '[item1] google callback status =',
        gr.status,
        gr.headers.location,
      );
      expect(gr.status).toBe(302);
      expect(gr.headers.location).not.toContain('error=');
    });

    it('GET /users/me returns the same field set the auth responses now return (no drift)', async () => {
      const u = await makeUser('drift', Role.CUSTOMER);
      const lr = await login(u.email, PASSWORD);
      const mr = await me((lr.body as Body).access_token as string);
      expect(mr.status).toBe(200);
      const meKeys = Object.keys((mr.body as Body).data as object).sort();
      const loginKeys = Object.keys((lr.body as Body).data as object).sort();
      console.log('[item1] /users/me keys =', JSON.stringify(meKeys));
      console.log('[item1] /auth/login keys =', JSON.stringify(loginKeys));
      // /users/me additionally loads `addresses`; otherwise identical.
      expect(meKeys.filter((k) => k !== 'addresses')).toEqual(
        loginKeys.filter((k) => k !== 'addresses'),
      );
    });
  });

  // ════════════════ Item 2 (qa B4 / security L2) ════════════════

  describe('item 2 — DELETE /users/me ends the session on the device', () => {
    it('B4 original repro: a successful delete emits clearing Set-Cookie for both cookies', async () => {
      const u = await makeUser('del', Role.CUSTOMER);
      const lr = await login(u.email, PASSWORD);
      const token = (lr.body as Body).access_token as string;

      const res = await deleteMe(token);
      console.log('[item2] delete status =', res.status);
      console.log('[item2] Set-Cookie =', JSON.stringify(setCookieHeader(res)));
      console.log('[item2] delete body =', JSON.stringify(res.body));

      expect(res.status).toBe(200);
      const cookies = setCookieHeader(res);
      expect(cookieNames(res).sort()).toEqual([
        'jinva_session',
        'refresh_token',
      ]);
      for (const c of cookies) {
        expect(c).toMatch(/^(refresh_token|jinva_session)=;/); // empty value
        expect(c).toMatch(/Max-Age=0/);
        expect(c).toMatch(/Path=\//);
        expect(c).toMatch(/HttpOnly/);
      }
      // Body unchanged in shape.
      const d = (res.body as Body).data as Record<string, unknown>;
      expect(d.deletedAt).toBeTruthy();
      expect(d.purgeAt).toBeTruthy();
      expect(d.retentionDays).toBe(30);
    });

    it('a live-commitments refusal clears NOTHING and leaves the caller authenticated', async () => {
      const u = await makeUser('delref', Role.CUSTOMER);
      const j = await jobRepo.save(
        jobRepo.create({
          customer: u.user,
          service,
          title: 'QA R4 live job',
          description: 'QA fixture',
          location: 'Accra',
          status: Status.OPEN,
          currency: 'GHS',
        }),
      );
      createdJobIds.push(j.id);

      const res = await deleteMe(u.token);
      console.log(
        '[item2] refusal status =',
        res.status,
        (res.body as Body).meta?.error,
      );
      console.log(
        '[item2] refusal Set-Cookie =',
        JSON.stringify(setCookieHeader(res)),
      );
      expect(res.status).toBe(409);
      expect((res.body as Body).meta?.error).toBe(
        'ACCOUNT_HAS_LIVE_COMMITMENTS',
      );
      expect(setCookieHeader(res)).toEqual([]);

      const after = await me(u.token);
      console.log('[item2] still authenticated after refusal =', after.status);
      expect(after.status).toBe(200);

      const row = await userRepo.findOne({
        where: { id: u.user.id },
        withDeleted: true,
      });
      expect(row?.deletedAt ?? null).toBeNull();
    });

    it('the refusal message is amount-free (money sweep on backend refusals)', async () => {
      const u = await makeUser('delmoney', Role.CUSTOMER);
      const j = await jobRepo.save(
        jobRepo.create({
          customer: u.user,
          service,
          title: 'QA R4 money-free job',
          description: 'QA fixture',
          location: 'Accra',
          status: Status.OPEN,
          currency: 'GHS',
        }),
      );
      createdJobIds.push(j.id);
      const res = await deleteMe(u.token);
      const msg = (res.body as Body).message as string;
      console.log('[item2] refusal message =', JSON.stringify(msg));
      expect(msg).not.toMatch(/\$|\d+\.\d{2}/);
      expect(msg).not.toContain('GH');
    });
  });

  // ════════════════ Item 6 (security L1) ════════════════

  describe('item 6 — Google sign-in cannot restore a password-only account', () => {
    const googleCallback = () =>
      request(server()).get(
        '/api/v1/auth/google/callback?code=qa&state=qa-r4-state',
      );

    it('L1 original repro: a soft-deleted PASSWORD-ONLY account is refused — nothing restored, no token, no cookie, no duplicate', async () => {
      const u = await makeUser('g-pwonly', Role.CUSTOMER);
      await softDelete(u.user.id, 2);
      googleProfile.email = u.email;
      googleProfile.providerId = `g-r4-pwonly-${uniq}`;

      const res = await googleCallback();
      console.log(
        '[item6] password-only refusal =',
        res.status,
        res.headers.location,
      );
      console.log(
        '[item6] refusal Set-Cookie =',
        JSON.stringify(setCookieHeader(res)),
      );

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=');
      expect(
        setCookieHeader(res).some((c) => c.startsWith('refresh_token=')),
      ).toBe(false);

      const row = await userRepo.findOne({
        where: { id: u.user.id },
        withDeleted: true,
      });
      console.log('[item6] deletedAt after refusal =', row?.deletedAt);
      expect(row?.deletedAt).toBeTruthy();

      const rows: { c: number }[] = await userRepo.manager.query(
        'select count(*)::int c from users where lower(email) = lower($1)',
        [u.email],
      );
      console.log('[item6] row count for that address =', rows[0].c);
      expect(rows[0].c).toBe(1);
    });

    it('…and its owner then restores normally through the password path', async () => {
      const u = await makeUser('g-pwonly2', Role.CUSTOMER);
      await softDelete(u.user.id, 2);
      googleProfile.email = u.email;
      googleProfile.providerId = `g-r4-pwonly2-${uniq}`;
      const refused = await googleCallback();
      expect(refused.headers.location).toContain('error=');

      const li = await login(u.email, PASSWORD);
      console.log(
        '[item6] password login after refusal =',
        li.status,
        (li.body as Body).meta?.error,
      );
      expect(li.status).toBe(403);
      expect((li.body as Body).meta?.error).toBe('ACCOUNT_PENDING_DELETION');

      const rs = await restore(u.email, PASSWORD);
      console.log('[item6] restore after refusal =', rs.status);
      expect(rs.status).toBe(200);
      const row = await userRepo.findOne({
        where: { id: u.user.id },
        withDeleted: true,
      });
      expect(row?.deletedAt ?? null).toBeNull();
    });

    it('control: a GENUINELY social-only account (no password hash at all) still restores inline, refresh_token issued, no duplicate', async () => {
      const u = await makeUser('g-social', Role.CUSTOMER, {
        social: true,
        noPassword: true,
      });
      await softDelete(u.user.id, 2);
      googleProfile.email = u.email;
      googleProfile.providerId = `g-r4-social-${uniq}`;

      // Round 3: this fixture is now asserted to be what it claims to be
      // before the flow runs. Round 2's version passed `{ social: true }`
      // alone, and `makeUser` hashes a password unless `noPassword` is also
      // set — so it was a social+password account and never modelled a
      // social-only signup. Against the tightened gate (`password IS NULL`,
      // not `is_social_login`) that fixture asserted the wrong thing and
      // failed, which is the correct outcome for what it actually was.
      // Read as a boolean: the hash itself is never selected into the log.
      const pwState: { hasPassword: boolean }[] = await userRepo.manager.query(
        'select (password is not null) as "hasPassword" from users where id = $1',
        [u.user.id],
      );
      console.log(
        '[item6] social-only fixture: hasPassword =',
        pwState[0].hasPassword,
      );
      expect(pwState[0].hasPassword).toBe(false);

      const res = await googleCallback();
      console.log('[item6] social restore =', res.status, res.headers.location);
      console.log(
        '[item6] social restore cookies =',
        JSON.stringify(cookieNames(res)),
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).not.toContain('error=');
      expect(
        setCookieHeader(res).some((c) => c.startsWith('refresh_token=')),
      ).toBe(true);

      const row = await userRepo.findOne({
        where: { id: u.user.id },
        withDeleted: true,
      });
      console.log('[item6] social deletedAt after restore =', row?.deletedAt);
      expect(row?.deletedAt ?? null).toBeNull();

      const rows: { c: number }[] = await userRepo.manager.query(
        'select count(*)::int c from users where lower(email) = lower($1)',
        [u.email],
      );
      expect(rows[0].c).toBe(1);
    });

    it('control: a LIVE password-only account signing in with Google still resolves to that account', async () => {
      const u = await makeUser('g-live', Role.CUSTOMER);
      googleProfile.email = u.email;
      googleProfile.providerId = `g-r4-live-${uniq}`;

      const res = await googleCallback();
      console.log(
        '[item6] live password-only google =',
        res.status,
        res.headers.location,
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).not.toContain('error=');

      const rows: { c: number }[] = await userRepo.manager.query(
        'select count(*)::int c from users where lower(email) = lower($1)',
        [u.email],
      );
      expect(rows[0].c).toBe(1);
    });

    it('edge case: a social-only account soft-deleted PAST the window is still refused and creates no duplicate', async () => {
      // `noPassword` deliberately: with a password on the row the refusal
      // would be the password gate's, and this case would pass without ever
      // exercising the 30-day window it is named after.
      const u = await makeUser('g-past', Role.CUSTOMER, {
        social: true,
        noPassword: true,
      });
      await softDelete(u.user.id, 45);
      googleProfile.email = u.email;
      googleProfile.providerId = `g-r4-past-${uniq}`;

      const res = await googleCallback();
      console.log('[item6] past-window =', res.status, res.headers.location);
      expect(res.headers.location).toContain('error=');

      const row = await userRepo.findOne({
        where: { id: u.user.id },
        withDeleted: true,
      });
      expect(row?.deletedAt).toBeTruthy();
      const rows: { c: number }[] = await userRepo.manager.query(
        'select count(*)::int c from users where lower(email) = lower($1)',
        [u.email],
      );
      expect(rows[0].c).toBe(1);
    });

    it('edge case: a soft-deleted social account that LATER added a password is now REFUSED, and recovers by password instead', async () => {
      // Round 3, re-cut. Round 2 asserted this account still restored through
      // Google — the exemption the tightened gate (`password IS NULL`)
      // deliberately removed, and documented as a behaviour change in
      // api-contract.md item 6 ("Changed — now refused. Not stranded: it has a
      // password, so it recovers through POST /auth/restore-account").
      // `makeUser` sets a password unless `noPassword` is passed, so
      // `{ social: true }` alone is exactly the social+password row this case
      // is about.
      const u = await makeUser('g-both', Role.CUSTOMER, { social: true });
      await softDelete(u.user.id, 2);
      googleProfile.email = u.email;
      googleProfile.providerId = `g-r4-both-${uniq}`;

      const pwState: { hasPassword: boolean; isSocial: boolean }[] =
        await userRepo.manager.query(
          `select (password is not null) as "hasPassword",
                  is_social_login as "isSocial"
             from users where id = $1`,
          [u.user.id],
        );
      console.log(
        '[item6] social+password fixture =',
        JSON.stringify(pwState[0]),
      );
      expect(pwState[0].hasPassword).toBe(true);
      expect(pwState[0].isSocial).toBe(true);

      const res = await googleCallback();
      console.log(
        '[item6] social+password google restore =',
        res.status,
        res.headers.location,
      );
      console.log(
        '[item6] social+password Set-Cookie =',
        JSON.stringify(setCookieHeader(res)),
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=');
      expect(
        setCookieHeader(res).some((c) => c.startsWith('refresh_token=')),
      ).toBe(false);

      const row = await userRepo.findOne({
        where: { id: u.user.id },
        withDeleted: true,
      });
      console.log(
        '[item6] social+password deletedAt after refusal =',
        row?.deletedAt,
      );
      expect(row?.deletedAt).toBeTruthy();

      const rows: { c: number }[] = await userRepo.manager.query(
        'select count(*)::int c from users where lower(email) = lower($1)',
        [u.email],
      );
      expect(rows[0].c).toBe(1);

      // Not stranded, which is the whole basis for the refusal being
      // acceptable: the password path still recovers this account.
      const rs = await restore(u.email, PASSWORD);
      console.log('[item6] social+password password restore =', rs.status);
      expect(rs.status).toBe(200);
      const restored = await userRepo.findOne({
        where: { id: u.user.id },
        withDeleted: true,
      });
      expect(restored?.deletedAt ?? null).toBeNull();
    });
  });

  // ════════════════ Item 9 (security L4) ════════════════

  describe('item 9 — the last usable ADMIN cannot self-delete', () => {
    /**
     * The guard counts usable admins **platform-wide**, so "this account is the
     * last usable admin" can only be staged by parking every other usable
     * ADMIN row — the real seeded ones *and* any admin fixture an earlier test
     * in this file left behind. Missing the latter is how a false pass happens:
     * the control test's live backup admin would otherwise still be cover.
     *
     * `keep` is the set of admins the case under test wants to stay usable.
     * Everything parked is recorded and put back in the caller's `finally`;
     * pre-existing rows are additionally restored from `adminSnapshot` in
     * `afterAll`, and the snapshot is on disk as a crash-safety net.
     */
    async function parkOtherAdmins(keep: number[]): Promise<number[]> {
      const rows: { id: number }[] = await userRepo.manager.query(
        `select id from users
          where role = 'ADMIN' and deleted_at is null and purged_at is null
            and is_banned = false and is_suspended = false
            and id <> all($1::int[])`,
        [keep],
      );
      const ids = rows.map((r) => r.id);
      if (ids.length) {
        await userRepo.manager.query(
          `update users set is_suspended = true, suspended_at = now()
             where id = any($1::int[])`,
          [ids],
        );
      }
      console.log(
        '[item9] parked other usable admins =',
        ids.join(',') || '(none)',
      );
      return ids;
    }

    /** Un-parks exactly the rows `parkOtherAdmins` suspended. */
    async function unpark(ids: number[]): Promise<void> {
      if (ids.length) {
        await userRepo.manager.query(
          `update users set is_suspended = false, suspended_at = null
             where id = any($1::int[])`,
          [ids],
        );
      }
      await restoreAdminSnapshot();
    }

    it('L4 original repro: the only usable admin is refused with 409 LAST_ADMIN_CANNOT_DELETE and nothing changes', async () => {
      const a = await makeUser('lastadmin', Role.ADMIN);
      let parked: number[] = [];
      try {
        parked = await parkOtherAdmins([a.user.id]);
        const before: { c: number }[] = await userRepo.manager.query(
          'select count(*)::int c from user_tokens where user_id = $1',
          [a.user.id],
        );

        const res = await deleteMe(a.token);
        console.log(
          '[item9] last-admin refusal =',
          res.status,
          (res.body as Body).meta?.error,
        );
        console.log(
          '[item9] message =',
          JSON.stringify((res.body as Body).message),
        );
        console.log(
          '[item9] refusal Set-Cookie =',
          JSON.stringify(setCookieHeader(res)),
        );

        expect(res.status).toBe(409);
        expect((res.body as Body).meta?.error).toBe('LAST_ADMIN_CANNOT_DELETE');
        // Distinct from the live-commitments code.
        expect((res.body as Body).meta?.error).not.toBe(
          'ACCOUNT_HAS_LIVE_COMMITMENTS',
        );
        // Item 2: a refusal clears nothing.
        expect(setCookieHeader(res)).toEqual([]);

        const msg = (res.body as Body).message as string;
        // Amount-free, and no bare number that reads as money — and per the
        // contract, no digit at all (it must not disclose the admin count).
        expect(msg).not.toMatch(/\$|\d/);
        expect(msg).not.toContain('GH');

        // Not soft-deleted; refresh tokens not revoked; still authenticated.
        const row = await userRepo.findOne({
          where: { id: a.user.id },
          withDeleted: true,
        });
        expect(row?.deletedAt ?? null).toBeNull();
        const after: { c: number }[] = await userRepo.manager.query(
          'select count(*)::int c from user_tokens where user_id = $1',
          [a.user.id],
        );
        console.log(
          '[item9] user_tokens before/after =',
          before[0].c,
          after[0].c,
        );
        expect(after[0].c).toBe(before[0].c);
        const stillMe = await me(a.token);
        console.log('[item9] still authenticated =', stillMe.status);
        expect(stillMe.status).toBe(200);
      } finally {
        await unpark(parked);
      }
    });

    it('control: with a second USABLE admin, deletion proceeds normally with the unchanged 200 body', async () => {
      const a = await makeUser('admindel', Role.ADMIN);
      const backup = await makeUser('adminbackup', Role.ADMIN);
      let parked: number[] = [];
      try {
        parked = await parkOtherAdmins([a.user.id, backup.user.id]);
        const res = await deleteMe(a.token);
        console.log(
          '[item9] two-admin delete =',
          res.status,
          JSON.stringify(res.body),
        );
        expect(res.status).toBe(200);
        const d = (res.body as Body).data as Record<string, unknown>;
        expect(d.deletedAt).toBeTruthy();
        expect(d.purgeAt).toBeTruthy();
        expect(d.retentionDays).toBe(30);
        // Item 2 on the success path for an ADMIN too.
        expect(cookieNames(res).sort()).toEqual([
          'jinva_session',
          'refresh_token',
        ]);
        expect(backup.user.id).toBeDefined();
      } finally {
        await unpark(parked);
      }
    });

    it('a soft-deleted second admin does NOT count as cover', async () => {
      const a = await makeUser('adm-sd', Role.ADMIN);
      const other = await makeUser('adm-sd2', Role.ADMIN);
      let parked: number[] = [];
      try {
        await softDelete(other.user.id, 1);
        parked = await parkOtherAdmins([a.user.id, other.user.id]);
        const res = await deleteMe(a.token);
        console.log(
          '[item9] soft-deleted backup =>',
          res.status,
          (res.body as Body).meta?.error,
        );
        expect(res.status).toBe(409);
        expect((res.body as Body).meta?.error).toBe('LAST_ADMIN_CANNOT_DELETE');
      } finally {
        await unpark(parked);
      }
    });

    it('a banned second admin does NOT count as cover', async () => {
      const a = await makeUser('adm-ban', Role.ADMIN);
      const other = await makeUser('adm-ban2', Role.ADMIN);
      let parked: number[] = [];
      try {
        await userRepo.manager.query(
          'update users set is_banned = true, banned_at = now() where id = $1',
          [other.user.id],
        );
        parked = await parkOtherAdmins([a.user.id, other.user.id]);
        const res = await deleteMe(a.token);
        console.log(
          '[item9] banned backup =>',
          res.status,
          (res.body as Body).meta?.error,
        );
        expect(res.status).toBe(409);
        expect((res.body as Body).meta?.error).toBe('LAST_ADMIN_CANNOT_DELETE');
      } finally {
        await unpark(parked);
      }
    });

    it('a suspended second admin does NOT count as cover', async () => {
      const a = await makeUser('adm-sus', Role.ADMIN);
      const other = await makeUser('adm-sus2', Role.ADMIN);
      let parked: number[] = [];
      try {
        await userRepo.manager.query(
          'update users set is_suspended = true, suspended_at = now() where id = $1',
          [other.user.id],
        );
        parked = await parkOtherAdmins([a.user.id, other.user.id]);
        const res = await deleteMe(a.token);
        console.log(
          '[item9] suspended backup =>',
          res.status,
          (res.body as Body).meta?.error,
        );
        expect(res.status).toBe(409);
        expect((res.body as Body).meta?.error).toBe('LAST_ADMIN_CANNOT_DELETE');
      } finally {
        await unpark(parked);
      }
    });

    it('a purged second admin does NOT count as cover', async () => {
      const a = await makeUser('adm-pg', Role.ADMIN);
      const other = await makeUser('adm-pg2', Role.ADMIN);
      let parked: number[] = [];
      try {
        await userRepo.manager.query(
          'update users set deleted_at = now(), purged_at = now() where id = $1',
          [other.user.id],
        );
        parked = await parkOtherAdmins([a.user.id, other.user.id]);
        const res = await deleteMe(a.token);
        console.log(
          '[item9] purged backup =>',
          res.status,
          (res.body as Body).meta?.error,
        );
        expect(res.status).toBe(409);
        expect((res.body as Body).meta?.error).toBe('LAST_ADMIN_CANNOT_DELETE');
      } finally {
        await unpark(parked);
      }
    });

    it('both last-admin AND live commitments produce ONE coherent 409 carrying the last-admin code only', async () => {
      const a = await makeUser('adm-both', Role.ADMIN);
      let parked: number[] = [];
      try {
        const j = await jobRepo.save(
          jobRepo.create({
            customer: a.user,
            service,
            title: 'QA R4 admin live job',
            description: 'QA fixture',
            location: 'Accra',
            status: Status.OPEN,
            currency: 'GHS',
          }),
        );
        createdJobIds.push(j.id);
        parked = await parkOtherAdmins([a.user.id]);

        const res = await deleteMe(a.token);
        const b = res.body as Body;
        console.log('[item9] both conditions =', res.status, JSON.stringify(b));
        expect(res.status).toBe(409);
        expect(b.meta?.error).toBe('LAST_ADMIN_CANNOT_DELETE');
        // Not two refusals stacked.
        expect(b.message).not.toMatch(/booking|job|payment|dispute/i);
      } finally {
        await unpark(parked);
      }
    });

    it('role boundary: a CUSTOMER and an ARTISAN with no commitments delete exactly as before', async () => {
      const c = await makeUser('rb-cust', Role.CUSTOMER);
      const r1 = await deleteMe(c.token);
      console.log(
        '[item9] customer delete =',
        r1.status,
        JSON.stringify(r1.body),
      );
      expect(r1.status).toBe(200);
      expect(
        ((r1.body as Body).data as Record<string, unknown>).retentionDays,
      ).toBe(30);

      const ar = await makeUser('rb-art', Role.ARTISAN);
      const prof = await profileRepo.save(
        profileRepo.create({ user: ar.user } as Partial<ArtisanProfile>),
      );
      createdProfileIds.push(prof.id);
      const r2 = await deleteMe(ar.token);
      console.log('[item9] artisan delete =', r2.status);
      expect(r2.status).toBe(200);
    });

    it('role boundary: a non-admin cannot trigger the admin refusal even when no usable admin exists', async () => {
      const c = await makeUser('rb-noadmin', Role.CUSTOMER);
      let parked: number[] = [];
      try {
        parked = await parkOtherAdmins([]);
        const res = await deleteMe(c.token);
        console.log('[item9] non-admin with zero usable admins =', res.status);
        expect(res.status).toBe(200);
      } finally {
        await unpark(parked);
      }
    });
  });

  // ════════════════ Round-3 regression: B1 / B2 / B3 / B6 ════════════════

  describe('round-3 regression — enumeration, timing and 404', () => {
    it('B2: POST /auth/register does not disclose that an email belongs to a deleted account', async () => {
      const del = await makeUser('b2-del', Role.CUSTOMER);
      await softDelete(del.user.id, 1);
      const live = await makeUser('b2-live', Role.CUSTOMER);

      const onDeleted = await request(server())
        .post('/api/v1/auth/register')
        .send({
          email: del.email,
          password: PASSWORD,
          username: `qar4b2d${uniq}`,
          firstname: 'Qa',
          lastname: 'B2',
          role: Role.CUSTOMER,
        });
      const onLive = await request(server())
        .post('/api/v1/auth/register')
        .send({
          email: live.email,
          password: PASSWORD,
          username: `qar4b2l${uniq}`,
          firstname: 'Qa',
          lastname: 'B2',
          role: Role.CUSTOMER,
        });

      console.log(
        '[B2] on soft-deleted =',
        onDeleted.status,
        JSON.stringify(onDeleted.body),
      );
      console.log(
        '[B2] on live        =',
        onLive.status,
        JSON.stringify(onLive.body),
      );
      // B2 forbids distinguishing *deleted* from *live*; it does not forbid
      // "taken vs free", which is inherent to registration. So compare the
      // message with the caller's own address normalised out, plus meta.error.
      const template = (b: Body, addr: string) =>
        (b.message as string).split(addr).join('<EMAIL>');
      expect(onDeleted.status).toBe(onLive.status);
      expect(template(onDeleted.body as Body, del.email)).toBe(
        template(onLive.body as Body, live.email),
      );
      expect((onDeleted.body as Body).meta?.error).toBe(
        (onLive.body as Body).meta?.error,
      );
      expect((onDeleted.body as Body).meta?.error).toBeTruthy();
      expect(JSON.stringify(onDeleted.body)).not.toMatch(/delet/i);
    });

    it('B3: GET /artisans/:id returns 404 (not 500) for a soft-deleted artisan, indistinguishable from nonexistent', async () => {
      const ar = await makeUser('b3-art', Role.ARTISAN);
      const prof = await profileRepo.save(
        profileRepo.create({ user: ar.user } as Partial<ArtisanProfile>),
      );
      createdProfileIds.push(prof.id);
      await softDelete(ar.user.id, 1);

      const soft = await request(server()).get(`/api/v1/artisans/${prof.id}`);
      const none = await request(server()).get('/api/v1/artisans/99999999');
      console.log(
        '[B3] soft-deleted =',
        soft.status,
        JSON.stringify(soft.body),
      );
      console.log(
        '[B3] nonexistent  =',
        none.status,
        JSON.stringify(none.body),
      );
      expect(soft.status).toBe(404);
      expect(none.status).toBe(404);
      expect((soft.body as Body).meta?.error).toBe(
        (none.body as Body).meta?.error,
      );
    });

    it('B1/B6: login and restore-account stay indistinguishable in body and timing across live / soft-deleted / never-registered', async () => {
      const live = await makeUser('t-live', Role.CUSTOMER);
      const del = await makeUser('t-del', Role.CUSTOMER);
      await softDelete(del.user.id, 1);
      const never = `qa-r4-never-${uniq}@test.jinva.local`;
      const WRONG = 'WrongHorse9!';

      const probe = async (
        fn: (e: string, p: string) => request.Test,
        e: string,
      ) => {
        const times: number[] = [];
        let last: request.Response | null = null;
        for (let i = 0; i < 6; i++) {
          const t0 = Date.now();
          last = await fn(e, WRONG);
          times.push(Date.now() - t0);
        }
        return { times, median: median(times), body: comparable(last!) };
      };

      const lLive = await probe(login, live.email);
      const lDel = await probe(login, del.email);
      const lNever = await probe(login, never);
      console.log(
        '[B6] login medians  live/soft-deleted/never =',
        lLive.median,
        lDel.median,
        lNever.median,
      );
      console.log(
        '[B6] login samples =',
        JSON.stringify({
          live: lLive.times,
          del: lDel.times,
          never: lNever.times,
        }),
      );
      console.log(
        '[B6] login bodies  =',
        JSON.stringify({
          live: lLive.body,
          del: lDel.body,
          never: lNever.body,
        }),
      );

      expect(lLive.body).toEqual(lDel.body);
      expect(lLive.body).toEqual(lNever.body);
      // No order-of-magnitude separation (the original oracle was ~7ms vs ~500ms).
      const lo = Math.min(lLive.median, lDel.median, lNever.median);
      const hi = Math.max(lLive.median, lDel.median, lNever.median);
      expect(lo).toBeGreaterThan(50);
      expect(hi / lo).toBeLessThan(3);

      const rLive = await probe(restore, live.email);
      const rDel = await probe(restore, del.email);
      const rNever = await probe(restore, never);
      console.log(
        '[B1] restore medians live/soft-deleted/never =',
        rLive.median,
        rDel.median,
        rNever.median,
      );
      console.log(
        '[B1] restore samples =',
        JSON.stringify({
          live: rLive.times,
          del: rDel.times,
          never: rNever.times,
        }),
      );
      console.log(
        '[B1] restore bodies  =',
        JSON.stringify({
          live: rLive.body,
          del: rDel.body,
          never: rNever.body,
        }),
      );

      expect(rLive.body).toEqual(rDel.body);
      expect(rLive.body).toEqual(rNever.body);
      const rlo = Math.min(rLive.median, rDel.median, rNever.median);
      const rhi = Math.max(rLive.median, rDel.median, rNever.median);
      expect(rlo).toBeGreaterThan(50);
      expect(rhi / rlo).toBeLessThan(3);
    });

    it('sanity: the pre-existing usable-admin population is intact', async () => {
      const rows: { id: number }[] = await userRepo.manager.query(
        `select id from users
          where role='ADMIN' and deleted_at is null and purged_at is null
            and is_banned=false and is_suspended=false
            and id = any($1::int[]) order by id`,
        [adminSnapshot.map((a) => a.id)],
      );
      console.log(
        '[item9] usable pre-existing admins =',
        rows.map((r) => r.id).join(','),
      );
      expect(rows.length).toBe(
        adminSnapshot.filter(
          (a) =>
            !a.deleted_at && !a.purged_at && !a.is_banned && !a.is_suspended,
        ).length,
      );
      expect(Not).toBeDefined();
      expect(IsNull).toBeDefined();
    });
  });
});
