/**
 * End-to-end coverage for the Google "complete your account" step: a
 * brand-new social user gets a pending signup (nothing in the database) and
 * only becomes a user once they pick a role on the complete-signup page.
 *
 * Only the Google *transport* is stubbed (`GoogleAuthStrategy` —
 * `getAccessToken` / `getUserProfile`). The `/auth/google` redirect, the real
 * CSRF state round trip (so `?role=artisan` really travels through the state),
 * the callback, the pending store, the cookies, the transaction and artisan
 * search are all real code against the real database.
 *
 * Run: npm run test:e2e -- social-complete-signup
 *
 * Every row this file creates uses a per-run unique email / phone / service
 * name and is deleted in `afterAll`.
 *
 * Isolation (test process only): local storage, and `MailService` is a stub,
 * so a run never writes to the real bucket or sends a real email.
 */
process.env.STORAGE_PROVIDER = 'local';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '10000';
process.env.AUTH_EMAIL_RATE_LIMIT_PER_MINUTE = '10000';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { In, Like, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import cookieParser from 'cookie-parser';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { CustomerProfile } from '@users/entities/customer-profile.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { GoogleAuthStrategy } from '../src/auth/strategy/google-auth.strategy';
import { MailService } from '../src/mail/mail.service';
import { VARIABLES } from '@common/constants/variables.constants';
import { Role } from '@common/types/enums';

jest.setTimeout(120000);

interface Body {
  status?: string;
  message?: string | string[];
  access_token?: string;
  data?: Record<string, unknown> | Record<string, unknown>[];
  meta?: { error?: string; statusCode?: number };
}

const PENDING = VARIABLES.PENDING_SOCIAL_SIGNUP_COOKIE_NAME;
const REFRESH = VARIABLES.REFRESH_TOKEN_COOKIE_NAME;
const SESSION = VARIABLES.AUTH_SESSION_COOKIE_NAME;

const uniq = Date.now();
const EMAIL_DOMAIN = `scs-${uniq}.test.jinva.local`;

/** Mutable so each test points the stubbed Google transport at its own email. */
const googleProfile = {
  email: `unset@${EMAIL_DOMAIN}`,
  firstname: 'Gina',
  lastname: 'Google',
  profilePicture: 'https://lh3.googleusercontent.test/pic.png',
  provider: 'google',
  providerId: 'scs-google-id',
};

describe('social complete-signup (e2e)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let userRepo: Repository<User>;
  let artisanProfileRepo: Repository<ArtisanProfile>;
  let customerProfileRepo: Repository<CustomerProfile>;
  let serviceRepo: Repository<ServiceEntity>;
  let service: ServiceEntity;

  const server = () => app.getHttpServer();
  const email = (label: string) => `${label}@${EMAIL_DOMAIN}`;
  let phoneSeq = 0;
  /**
   * PH10: a per-run unique, **valid** Ghana number in E.164 — `+23324` (a real
   * mobile range) + 7 digits. The old `0NN-…` generator produced ranges
   * libphonenumber-js rejects for GH (e.g. `001-…`).
   */
  const phone = () => {
    phoneSeq += 1;
    return `+23324${String(phoneSeq).padStart(2, '0')}${String(uniq).slice(-5)}`;
  };
  /** The same number written the way a user types it (PH2): `024XXXXXXX`. */
  const national = (e164: string) => `0${e164.slice(4)}`;

  const setCookies = (res: request.Response): Record<string, string> => {
    const raw: unknown = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const byName: Record<string, string> = {};
    for (const c of list) byName[String(c).split('=')[0]] = String(c);
    return byName;
  };
  const cookieValue = (header: string | undefined) =>
    header ? header.split(';')[0].split('=').slice(1).join('=') : undefined;
  const isCleared = (header: string | undefined) =>
    Boolean(header) &&
    (/Max-Age=0/i.test(header!) || /Expires=Thu, 01 Jan 1970/i.test(header!));

  /**
   * Runs the whole browser flow: `/auth/google[?role=]` → state → callback.
   * Returns the callback response and the pending key (if one was set).
   */
  async function googleFlow(
    profileEmail: string,
    role?: string,
  ): Promise<{ res: request.Response; key?: string }> {
    googleProfile.email = profileEmail;
    googleProfile.providerId = `scs-google-${profileEmail}`;
    const start = await request(server())
      .get('/api/v1/auth/google')
      .query(role ? { role } : {});
    expect(start.status).toBe(302);
    const state = new URL(String(start.headers.location)).searchParams.get(
      'state',
    );
    expect(state).toBeTruthy();
    const res = await request(server())
      .get('/api/v1/auth/google/callback')
      .query({ code: 'scs-code', state });
    return { res, key: cookieValue(setCookies(res)[PENDING]) };
  }

  const pending = (key?: string) => {
    const r = request(server()).get('/api/v1/auth/social/pending');
    return key ? r.set('Cookie', `${PENDING}=${key}`) : r;
  };
  const complete = (key: string | undefined, body: Record<string, unknown>) => {
    const r = request(server()).post('/api/v1/auth/social/complete');
    return (key ? r.set('Cookie', `${PENDING}=${key}`) : r).send(body);
  };
  const cancel = (key?: string) => {
    const r = request(server()).post('/api/v1/auth/social/cancel');
    return key ? r.set('Cookie', `${PENDING}=${key}`) : r;
  };

  const usersWithEmail = (e: string) =>
    userRepo.find({ where: { email: e }, withDeleted: true });

  const artisanBody = (overrides: Record<string, unknown> = {}) => ({
    role: 'ARTISAN',
    firstname: 'Gina',
    lastname: 'Google',
    phoneNumber: phone(),
    gender: 'FEMALE',
    serviceIds: [service.id],
    location: `Scsville ${uniq}`,
    hourlyRate: 55.5,
    bio: 'Plumber who signed up with Google.',
    businessName: 'Gina Plumbing',
    experienceYears: 4,
    ...overrides,
  });

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GoogleAuthStrategy)
      .useValue({
        getProviderName: () => 'google',
        getAuthorizationUrl: (state: string) =>
          `https://accounts.google.test/auth?state=${state}`,
        getAccessToken: () => Promise.resolve('scs-provider-token'),
        getUserProfile: () => Promise.resolve({ ...googleProfile }),
      })
      .overrideProvider(MailService)
      .useValue({ sendMail: () => Promise.resolve() })
      .compile();

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

    userRepo = moduleFixture.get(getRepositoryToken(User));
    artisanProfileRepo = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    customerProfileRepo = moduleFixture.get(
      getRepositoryToken(CustomerProfile),
    );
    serviceRepo = moduleFixture.get(getRepositoryToken(ServiceEntity));
    service = await serviceRepo.save(
      serviceRepo.create({
        name: `SCS Service ${uniq}`,
        estimatedDurationMins: 60,
      }),
    );
  });

  afterAll(async () => {
    const mine = await userRepo.find({
      where: { email: Like(`%@${EMAIL_DOMAIN}`) },
      withDeleted: true,
    });
    const ids = mine.map((u) => u.id);
    if (ids.length) {
      await artisanProfileRepo
        .createQueryBuilder()
        .delete()
        .where('user_id IN (:...ids)', { ids })
        .execute()
        .catch(() => undefined);
      await customerProfileRepo
        .createQueryBuilder()
        .delete()
        .where('user_id IN (:...ids)', { ids })
        .execute()
        .catch(() => undefined);
      await userRepo.delete({ id: In(ids) }).catch(() => undefined);
    }
    if (service) await serviceRepo.delete(service.id).catch(() => undefined);
    await app.close();
  });

  // (a) + (b)
  it('(a) new email: callback writes nothing, sets only the pending cookie, 302 to /auth/complete-signup; (b) pending returns profile + suggestedRole', async () => {
    const e = email('a-artisan');
    const { res, key } = await googleFlow(e, 'artisan');
    const cookies = setCookies(res);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `${process.env.FRONTEND_URL ?? ''}/auth/complete-signup`,
    );
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(cookies[PENDING]).toMatch(/HttpOnly/i);
    expect(cookies[PENDING]).toMatch(/SameSite=Lax/i);
    expect(cookies[PENDING]).toMatch(/Path=\/api\/v1\/auth/);
    expect(cookies[PENDING]).toMatch(/Max-Age=900/);
    expect(cookies[REFRESH]).toBeUndefined();
    expect(cookies[SESSION]).toBeUndefined();
    expect(await usersWithEmail(e)).toHaveLength(0);

    const p = await pending(key);
    expect(p.status).toBe(200);
    expect((p.body as Body).data).toEqual({
      email: e,
      firstname: 'Gina',
      lastname: 'Google',
      profilePicture: googleProfile.profilePicture,
      suggestedRole: Role.ARTISAN,
      provider: 'google',
    });
    // Read-only: a second read still works.
    expect((await pending(key)).status).toBe(200);
  });

  it('(b) login-page flow (no role) suggests nothing; an off-contract role suggests nothing', async () => {
    const { key } = await googleFlow(email('b-norole'));
    expect(
      ((await pending(key)).body as { data: { suggestedRole: unknown } }).data
        .suggestedRole,
    ).toBeNull();
    const { key: k2 } = await googleFlow(email('b-admin'), 'admin');
    expect(
      ((await pending(k2)).body as { data: { suggestedRole: unknown } }).data
        .suggestedRole,
    ).toBeNull();
    expect(await usersWithEmail(email('b-admin'))).toHaveLength(0);
  });

  it('pending with no cookie / unknown cookie → 401 SOCIAL_SIGNUP_EXPIRED', async () => {
    for (const r of [await pending(), await pending('f'.repeat(64))]) {
      expect(r.status).toBe(401);
      expect((r.body as Body).meta?.error).toBe('SOCIAL_SIGNUP_EXPIRED');
    }
  });

  // (c)
  it('(c) invalid complete bodies → 400 and the pending entry still works', async () => {
    const e = email('c-invalid');
    const { key } = await googleFlow(e, 'artisan');

    const bad: Array<Record<string, unknown>> = [
      artisanBody({ serviceIds: undefined }),
      // PH4: not a valid number for the country, too short, unsupported country.
      artisanBody({ phoneNumber: '123-456-7890' }),
      artisanBody({ phoneNumber: '024123456' }),
      artisanBody({ phoneNumber: '+44 7911 123456' }),
      // DI5: gender is required, and OTHER is no longer accepted as input.
      artisanBody({ gender: undefined }),
      artisanBody({ gender: 'OTHER' }),
      artisanBody({ hourlyRate: 0 }),
      artisanBody({ serviceIds: [] }),
      artisanBody({ firstname: '   ' }),
      artisanBody({ role: 'ADMIN' }),
      {
        role: 'CUSTOMER',
        firstname: 'Gina',
        lastname: 'Google',
        gender: 'FEMALE',
      }, // no phone
    ];
    for (const body of bad) {
      const r = await complete(key, body);
      expect({ body, status: r.status }).toEqual({ body, status: 400 });
    }
    // Unknown service id: a 400 too, and it must not consume the entry.
    const unknownSvc = await complete(
      key,
      artisanBody({ serviceIds: [2147483000] }),
    );
    expect(unknownSvc.status).toBe(400);

    expect((await pending(key)).status).toBe(200);
    expect(await usersWithEmail(e)).toHaveLength(0);
  });

  // PH2/PH7 + B1/B2: what used to be a 400 (`0241234567`) is now accepted.
  it('national phone input is stored as E.164, and an ARTISAN without a bio is still searchable', async () => {
    const e = email('c-national');
    const { key } = await googleFlow(e, 'artisan');
    const e164 = phone();
    const r = await complete(
      key,
      artisanBody({ phoneNumber: national(e164), bio: '   ' }),
    );
    expect(r.status).toBe(200);

    const [user] = await usersWithEmail(e);
    expect(user.phoneNumber).toBe(e164);
    expect(user.gender).toBe('FEMALE');
    const profile = await artisanProfileRepo.findOne({
      where: { user: { id: user.id } },
    });
    expect(profile!.bio).toBeNull();
    expect(profile!.isProfileComplete).toBe(true);

    const search = await request(server())
      .get('/api/v1/artisans')
      .query({ serviceId: service.id });
    const listed = (search.body as { data: Array<{ id: number }> }).data.map(
      (a) => a.id,
    );
    expect(listed).toContain(profile!.id);
  });

  // (d)
  it('(d) ARTISAN complete → user + complete artisan profile with services, searchable, login cookies set, pending cleared; replay → 401', async () => {
    const e = email('d-artisan');
    const { key } = await googleFlow(e, 'artisan');
    const body = artisanBody();
    const r = await complete(key, body);
    const b = r.body as Body & { data: Record<string, unknown> };
    const cookies = setCookies(r);

    expect(r.status).toBe(200);
    expect(typeof b.access_token).toBe('string');
    expect(b.data.email).toBe(e);
    expect(b.data.role).toBe(Role.ARTISAN);
    expect(cookies[REFRESH]).toMatch(/HttpOnly/i);
    expect(cookieValue(cookies[REFRESH])).toBeTruthy();
    expect(cookieValue(cookies[SESSION])).toBeTruthy();
    expect(isCleared(cookies[PENDING])).toBe(true);

    const [user] = await usersWithEmail(e);
    expect(user).toBeDefined();
    expect(user.role).toBe(Role.ARTISAN);
    expect(user.accountVerified).toBe(true);
    expect(user.verifiedAt).toBeTruthy();
    expect(user.isSocialLogin).toBe(true);
    expect(user.socialProvider).toBe('google');
    expect(user.socialProviderId).toBe(`scs-google-${e}`);
    // `password` is `select: false` on the entity, so read it explicitly.
    const [{ password }] = await userRepo.query<Array<{ password: unknown }>>(
      'SELECT password FROM users WHERE id = $1',
      [user.id],
    );
    expect(password).toBeNull();
    expect(user.phoneNumber).toBe(body.phoneNumber);

    const profile = await artisanProfileRepo.findOne({
      where: { user: { id: user.id } },
      relations: ['services'],
    });
    expect(profile).toBeTruthy();
    expect(profile!.isProfileComplete).toBe(true);
    expect(profile!.services.map((s) => s.id)).toEqual([service.id]);
    expect(profile!.location).toBe(body.location);
    expect(Number(profile!.hourlyRate)).toBe(55.5);
    expect(profile!.bio).toBe(body.bio);
    expect(profile!.businessName).toBe('Gina Plumbing');
    expect(profile!.experienceYears).toBe(4);

    const search = await request(server())
      .get('/api/v1/artisans')
      .query({ serviceId: service.id });
    expect(search.status).toBe(200);
    const listed = (search.body as { data: Array<{ id: number }> }).data.map(
      (a) => a.id,
    );
    expect(listed).toContain(profile!.id);

    // The new session really is a session.
    const me = await request(server())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${b.access_token}`);
    expect(me.status).toBe(200);

    const replay = await complete(key, artisanBody());
    expect(replay.status).toBe(401);
    expect((replay.body as Body).meta?.error).toBe('SOCIAL_SIGNUP_EXPIRED');
    expect(await usersWithEmail(e)).toHaveLength(1);

    // Next Google sign-in for that email is an ordinary login now.
    const again = await googleFlow(e);
    expect(again.res.headers.location).toMatch(/\/auth\/callback$/);
    expect(again.key).toBeUndefined();
  });

  // (e)
  it('(e) CUSTOMER complete (artisan suggested, customer chosen, leftover artisan fields ignored)', async () => {
    const e = email('e-customer');
    const { key } = await googleFlow(e, 'artisan');
    const r = await complete(key, {
      role: 'CUSTOMER',
      firstname: 'Cus',
      lastname: 'Tomer',
      phoneNumber: phone(),
      gender: 'FEMALE',
      dateOfBirth: '1995-10-25',
      location: 'leftover',
    });
    expect(r.status).toBe(200);
    expect((r.body as { data: { role: string } }).data.role).toBe(
      Role.CUSTOMER,
    );
    const [user] = await usersWithEmail(e);
    expect(user.role).toBe(Role.CUSTOMER);
    expect(user.firstname).toBe('Cus');
    expect(user.accountVerified).toBe(true);
    expect(
      await customerProfileRepo.count({ where: { user: { id: user.id } } }),
    ).toBe(1);
    expect(
      await artisanProfileRepo.count({ where: { user: { id: user.id } } }),
    ).toBe(0);
  });

  it('(e) role=ADMIN rejected and creates nothing', async () => {
    const e = email('e-admin');
    const { key } = await googleFlow(e);
    const r = await complete(key, {
      role: 'ADMIN',
      firstname: 'Ad',
      lastname: 'Min',
      phoneNumber: phone(),
      gender: 'MALE',
    });
    expect(r.status).toBe(400);
    expect(await usersWithEmail(e)).toHaveLength(0);
    expect((await pending(key)).status).toBe(200);
  });

  // (f)
  it('(f) cancel → pending 401; cancel is idempotent and clears the cookie', async () => {
    const e = email('f-cancel');
    const { key } = await googleFlow(e, 'customer');
    const c1 = await cancel(key);
    expect(c1.status).toBe(200);
    expect(isCleared(setCookies(c1)[PENDING])).toBe(true);
    const p = await pending(key);
    expect(p.status).toBe(401);
    expect((p.body as Body).meta?.error).toBe('SOCIAL_SIGNUP_EXPIRED');
    expect((await cancel(key)).status).toBe(200);
    expect((await cancel()).status).toBe(200);
    const late = await complete(key, {
      role: 'CUSTOMER',
      firstname: 'A',
      lastname: 'B',
      phoneNumber: phone(),
      gender: 'MALE',
    });
    expect(late.status).toBe(401);
    expect(await usersWithEmail(e)).toHaveLength(0);
  });

  // (g)
  it('(g) abandon: a second callback for the same email makes a fresh entry and still no user', async () => {
    const e = email('g-abandon');
    const first = await googleFlow(e, 'artisan');
    // ...user closes the tab. Later, from the login page:
    const second = await googleFlow(e);
    expect(second.res.status).toBe(302);
    expect(second.res.headers.location).toMatch(/\/auth\/complete-signup$/);
    expect(second.key).toBeTruthy();
    expect(second.key).not.toBe(first.key);
    expect(await usersWithEmail(e)).toHaveLength(0);
    const p = await pending(second.key);
    expect(p.status).toBe(200);
    // The second flow started from the login page, so it asks again.
    expect(
      (p.body as { data: { suggestedRole: unknown } }).data.suggestedRole,
    ).toBeNull();
  });

  // (h)
  it('(h) existing user callback unchanged: refresh + session cookies, redirect to /auth/callback, no pending cookie', async () => {
    const e = email('h-existing');
    await userRepo.save(
      userRepo.create({
        email: e,
        password: null,
        firstname: 'Ex',
        lastname: 'Isting',
        role: Role.ARTISAN,
        accountVerified: true,
        isBanned: false,
        isSuspended: false,
        isSocialLogin: true,
        socialProvider: 'google',
        socialProviderId: `scs-google-${e}`,
      } as Partial<User>),
    );
    const { res, key } = await googleFlow(e, 'customer');
    const cookies = setCookies(res);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `${process.env.FRONTEND_URL ?? ''}/auth/callback`,
    );
    expect(cookieValue(cookies[REFRESH])).toBeTruthy();
    expect(cookieValue(cookies[SESSION])).toBeTruthy();
    expect(key).toBeUndefined();
    const rows = await usersWithEmail(e);
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe(Role.ARTISAN);
  });

  it('race: email registered while pending → 409, no duplicate, cookie cleared', async () => {
    const e = email('race');
    const { key } = await googleFlow(e);
    await userRepo.save(
      userRepo.create({
        email: e,
        password: null,
        firstname: 'Ra',
        lastname: 'Ce',
        role: Role.CUSTOMER,
        accountVerified: true,
        isBanned: false,
        isSuspended: false,
        isSocialLogin: false,
      } as Partial<User>),
    );
    const r = await complete(key, {
      role: 'CUSTOMER',
      firstname: 'Ra',
      lastname: 'Ce',
      phoneNumber: phone(),
      gender: 'FEMALE',
    });
    expect(r.status).toBe(409);
    expect((r.body as Body).meta?.error).toBe('UserAlreadyExists');
    expect(isCleared(setCookies(r)[PENDING])).toBe(true);
    expect(await usersWithEmail(e)).toHaveLength(1);
  });

  it('phone number already in use → 409 PHONE_NUMBER_IN_USE (even typed nationally), nothing created, the pending entry survives for a resubmit', async () => {
    const taken = phone();
    const e1 = email('phone-1');
    const k1 = (await googleFlow(e1)).key;
    expect(
      (
        await complete(k1, {
          role: 'CUSTOMER',
          firstname: 'Ph',
          lastname: 'One',
          phoneNumber: taken,
          gender: 'MALE',
        })
      ).status,
    ).toBe(200);

    const e2 = email('phone-2');
    const k2 = (await googleFlow(e2, 'artisan')).key;
    // PH9: `024…` against a stored `+233…` is the same number.
    const dup = await complete(
      k2,
      artisanBody({ phoneNumber: national(taken) }),
    );
    expect(dup.status).toBe(409);
    expect((dup.body as Body).meta?.error).toBe('PHONE_NUMBER_IN_USE');
    expect(await usersWithEmail(e2)).toHaveLength(0);
    expect((await pending(k2)).status).toBe(200);
    const fixed = await complete(k2, artisanBody());
    expect(fixed.status).toBe(200);
    expect(await usersWithEmail(e2)).toHaveLength(1);
  });

  it('double submit in parallel creates exactly one account', async () => {
    const e = email('double');
    const { key } = await googleFlow(e, 'artisan');
    const [r1, r2] = await Promise.all([
      complete(key, artisanBody()),
      complete(key, artisanBody()),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 401]);
    expect(await usersWithEmail(e)).toHaveLength(1);
  });

  // (i)
  it('(i) expiry: after 15 minutes the entry is gone (pending and complete → 401), nothing created', async () => {
    const e = email('i-expiry');
    const { key } = await googleFlow(e, 'artisan');
    const base = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(base + 14 * 60 * 1000);
    try {
      expect((await pending(key)).status).toBe(200);
      spy.mockReturnValue(base + 15 * 60 * 1000 + 1000);
      const p = await pending(key);
      expect(p.status).toBe(401);
      expect((p.body as Body).meta?.error).toBe('SOCIAL_SIGNUP_EXPIRED');
      const c = await complete(key, artisanBody());
      expect(c.status).toBe(401);
    } finally {
      spy.mockRestore();
    }
    // Swept, not merely hidden: real time again and it is still gone.
    expect((await pending(key)).status).toBe(401);
    expect(await usersWithEmail(e)).toHaveLength(0);
  });
});
