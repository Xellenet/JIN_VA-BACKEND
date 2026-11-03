/**
 * Auth v2 end to end, over real HTTP against the hermetic database
 * (test/support: in-process Postgres with every migration, generated keys,
 * network refused, mail transport stubbed):
 *
 * - register (no username, no gender) → the code from the mocked mail →
 *   verify → session cookies → GET /users/me;
 * - wrong code ×5 → locked; an expired code; a login code for an existing
 *   account; a login code for an unknown address (same answer, no mail);
 * - forgot → reset → the old refresh token is rejected;
 * - an existing address at sign-up answers the same and mails the owner;
 * - old clients still sending username and gender; ADMIN still rejected;
 * - the Google complete-signup step with only a phone;
 * - usernames editable through PATCH /users/me, unique;
 * - the per-address cooldown; the old /auth/verify-email link still works.
 *
 * Turnstile is not configured here (the check is skipped, as in dev); its
 * enabled behaviour is in auth-v2-turnstile.e2e-spec.ts.
 *
 * Every address is a per-run @example.com one; rows are deleted in afterAll.
 *
 * Run: npm run test:e2e -- auth-v2.e2e --runInBand
 */
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '10000';
process.env.AUTH_EMAIL_RATE_LIMIT_PER_MINUTE = '10000';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { DataSource, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcrypt';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { User } from '@users/entities/user.entity';
import { UserTokenService } from '@users/token.service';
import { MailService } from '../src/mail/mail.service';
import { MailEvent } from '../src/mail/events/mail.events';
import { PendingSocialSignupService } from '../src/auth/pending-social-signup.service';
import { VARIABLES } from '@common/constants/variables.constants';
import { Role, Token } from '@common/types/enums';

jest.setTimeout(180000);

interface Body {
  status?: string;
  message?: string | string[];
  access_token?: string;
  data?: Record<string, unknown>;
  meta?: { error?: string; statusCode?: number; retryAfterSeconds?: number };
}

const PASSWORD = 'Fict1onal!Pass';
const NEW_PASSWORD = 'N3w#Fictional';
const REFRESH = VARIABLES.REFRESH_TOKEN_COOKIE_NAME;
const SESSION = VARIABLES.AUTH_SESSION_COOKIE_NAME;

describe('Auth v2 (e2e)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let userRepo: Repository<User>;
  let dataSource: DataSource;
  let mailSpy: jest.SpyInstance;
  const uniq = Date.now();
  const tail = String(uniq).slice(-6);
  const server = () => app.getHttpServer();
  const email = (label: string) => `av2-${label}-${uniq}@example.com`;
  let phoneSeq = 0;
  const phone = () => {
    phoneSeq += 1;
    return `+23324${String(phoneSeq).padStart(2, '0')}${tail.slice(-5)}`;
  };

  type Sent = { to: string; event: string; data: Record<string, unknown> };
  const mails = (): Sent[] =>
    mailSpy.mock.calls.map(([to, event, data]) => ({
      to: String(to),
      event: String(event),
      data: data as Record<string, unknown>,
    }));
  const mailsTo = (to: string, event?: string) =>
    mails().filter((m) => m.to === to && (!event || m.event === event));

  /** Listeners run after the response; wait for the mail to land. */
  async function waitForMail(
    to: string,
    event: string,
    count = 1,
  ): Promise<Sent> {
    for (let i = 0; i < 100; i++) {
      const found = mailsTo(to, event);
      if (found.length >= count) return found[count - 1];
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no ${event} mail arrived`);
  }
  const codeFor = async (to: string, count = 1) =>
    String((await waitForMail(to, MailEvent.AUTH_CODE, count)).data.code);

  const setCookies = (res: request.Response): Record<string, string> => {
    const raw: unknown = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const byName: Record<string, string> = {};
    for (const c of list) byName[String(c).split('=')[0]] = String(c);
    return byName;
  };
  const cookieValue = (header: string | undefined) =>
    header ? header.split(';')[0].split('=').slice(1).join('=') : undefined;

  const post = (path: string, body: Record<string, unknown>) =>
    request(server()).post(`/api/v1/auth/${path}`).send(body);

  const registerBody = (
    label: string,
    extra: Record<string, unknown> = {},
  ) => ({
    email: email(label),
    password: PASSWORD,
    firstname: 'Kofi',
    lastname: 'Asanté',
    phoneNumber: phone(),
    role: 'CUSTOMER',
    ...extra,
  });

  /** Lets the next code request for this address through the 60 s cooldown. */
  async function skipCooldown(address: string) {
    await dataSource.query(
      `UPDATE "auth_code_requests" SET "last_sent_at" = NOW() - interval '2 minutes'`,
    );
    void address;
  }

  async function makeUser(
    label: string,
    extra: Partial<User> = {},
  ): Promise<User> {
    return userRepo.save(
      userRepo.create({
        email: email(label),
        password: await bcrypt.hash(PASSWORD, 4),
        firstname: 'Esi',
        lastname: 'Owusu',
        username: `av2.${label}${tail}`.slice(0, 30),
        role: Role.CUSTOMER,
        accountVerified: true,
        verifiedAt: new Date(),
        phoneNumber: phone(),
        ...extra,
      }),
    );
  }

  const events = (userId: number) =>
    dataSource.query<
      Array<{ event: string; details: Record<string, unknown> | null }>
    >(
      `SELECT "event", "details" FROM "account_security_events" WHERE "user_id" = $1 ORDER BY "id"`,
      [userId],
    );

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
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
    userRepo = moduleFixture.get(getRepositoryToken(User));
    dataSource = moduleFixture.get(DataSource);
    // The e2e isolation already stubs delivery; this records what would be sent.
    mailSpy = jest.spyOn(app.get(MailService), 'sendMail');
  });

  afterAll(async () => {
    const rows = await dataSource.query<Array<{ id: number }>>(
      `SELECT "id" FROM "users" WHERE "email" LIKE $1`,
      [`av2-%-${uniq}@example.com`],
    );
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      for (const table of [
        'auth_codes',
        'account_security_events',
        'user_tokens',
        'notification_preferences',
        'notifications',
        'customer_profiles',
        'artisan_profiles',
      ]) {
        await dataSource
          .query(`DELETE FROM ${table} WHERE user_id = ANY($1)`, [ids])
          .catch(() => undefined);
      }
      await dataSource.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
    }
    await dataSource
      .query('DELETE FROM "auth_code_requests"')
      .catch(() => undefined);
    await app.close();
  });

  it('register → code from the mail → verify → session cookies → /users/me', async () => {
    const reg = await post('register', registerBody('flow'));
    expect(reg.status).toBe(201);
    expect(reg.body).toEqual({
      message: 'Check your email for a 6-digit code.',
      data: {
        email: email('flow'),
        resendAvailableAt: expect.any(String) as string,
      },
    });
    expect(setCookies(reg)[REFRESH]).toBeUndefined();

    const user = await userRepo.findOneOrFail({
      where: { email: email('flow') },
    });
    expect(user.username).toMatch(/^kofi\.asante\d*$/);
    expect(user.gender).toBeNull();
    expect(user.accountVerified).toBeFalsy();

    const code = await codeFor(email('flow'));
    expect(code).toMatch(/^\d{6}$/);
    const stored = await dataSource.query<Array<{ code_hash: string }>>(
      `SELECT "code_hash" FROM "auth_codes" WHERE "user_id" = $1`,
      [user.id],
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].code_hash).not.toContain(code);

    // Password login is still blocked until the email is confirmed.
    expect(
      (await post('login', { email: email('flow'), password: PASSWORD }))
        .status,
    ).toBe(403);

    const verified = await post('code/verify', {
      email: email('flow').toUpperCase(),
      code,
      purpose: 'signup',
    });
    expect(verified.status).toBe(200);
    const body = verified.body as Body & { access_token: string };
    expect(body.access_token).toEqual(expect.any(String));
    expect(body.data).toMatchObject({ id: user.id, email: email('flow') });
    expect(JSON.stringify(body)).not.toMatch(/refresh|\$2b\$|password/i);
    const cookies = setCookies(verified);
    expect(cookies[REFRESH]).toMatch(/HttpOnly/i);
    expect(cookies[SESSION]).toMatch(/HttpOnly/i);

    const me = await request(server())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${body.access_token}`);
    expect(me.status).toBe(200);
    expect((me.body as Body).data).toMatchObject({ id: user.id });

    expect(
      (await userRepo.findOneByOrFail({ id: user.id })).accountVerified,
    ).toBe(true);
    await waitForMail(email('flow'), MailEvent.WELCOME_USER);
    // The code is single use.
    expect(
      (
        await post('code/verify', {
          email: email('flow'),
          code,
          purpose: 'signup',
        })
      ).status,
    ).toBe(400);
    // The refresh cookie rotates like a password login's.
    const refreshed = await request(server())
      .post('/api/v1/auth/refresh-token')
      .set('Cookie', `${REFRESH}=${cookieValue(cookies[REFRESH])}`);
    expect(refreshed.status).toBe(200);

    const logged = await events(user.id);
    expect(logged.map((e) => e.event)).toEqual(
      expect.arrayContaining(['auth.signup', 'auth.code_sent', 'auth.login']),
    );
    expect(logged.find((e) => e.event === 'auth.login')?.details).toEqual({
      method: 'code',
    });
    expect(JSON.stringify(logged)).not.toContain(code);
    expect(JSON.stringify(logged)).not.toContain(PASSWORD);
  });

  it('wrong code ×5 → CODE_ATTEMPTS_EXCEEDED, and then even the right code is refused', async () => {
    await post('register', registerBody('wrong')).expect(201);
    const code = await codeFor(email('wrong'));
    const wrong = code === '000000' ? '111111' : '000000';
    const errors: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await post('code/verify', {
        email: email('wrong'),
        code: wrong,
        purpose: 'signup',
      });
      expect(res.status).toBe(400);
      errors.push(String((res.body as Body).meta?.error));
    }
    expect(errors).toEqual([
      'CODE_INVALID',
      'CODE_INVALID',
      'CODE_INVALID',
      'CODE_INVALID',
      'CODE_ATTEMPTS_EXCEEDED',
    ]);
    const right = await post('code/verify', {
      email: email('wrong'),
      code,
      purpose: 'signup',
    });
    expect(right.status).toBe(400);
    expect((right.body as Body).meta?.error).toBe('CODE_ATTEMPTS_EXCEEDED');

    const user = await userRepo.findOneByOrFail({ email: email('wrong') });
    const names = (await events(user.id)).map((e) => e.event);
    expect(
      names.filter((n) => n === 'auth.code_failed').length,
    ).toBeGreaterThanOrEqual(5);
    expect(names.filter((n) => n === 'auth.code_locked')).toHaveLength(1);

    // A new code (after the cooldown) works.
    await skipCooldown(email('wrong'));
    await post('code/request', {
      email: email('wrong'),
      purpose: 'signup',
    }).expect(200);
    const fresh = await codeFor(email('wrong'), 2);
    expect(
      (
        await post('code/verify', {
          email: email('wrong'),
          code: fresh,
          purpose: 'signup',
        })
      ).status,
    ).toBe(200);
  });

  it('an expired code answers CODE_INVALID with the one message', async () => {
    await post('register', registerBody('expired')).expect(201);
    const code = await codeFor(email('expired'));
    await dataSource.query(
      `UPDATE "auth_codes" SET "expires_at" = NOW() - interval '1 minute'
        WHERE "user_id" = (SELECT "id" FROM "users" WHERE "email" = $1)`,
      [email('expired')],
    );
    const res = await post('code/verify', {
      email: email('expired'),
      code,
      purpose: 'signup',
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      message: "That code didn't work. Check it or ask for a new one.",
      meta: { error: 'CODE_INVALID' },
    });
  });

  it('a sign-up code does not work as a login code (purpose binding)', async () => {
    await post('register', registerBody('purpose')).expect(201);
    const code = await codeFor(email('purpose'));
    const res = await post('code/verify', {
      email: email('purpose'),
      code,
      purpose: 'login',
    });
    expect((res.body as Body).meta?.error).toBe('CODE_INVALID');
    expect(
      (
        await post('code/verify', {
          email: email('purpose'),
          code,
          purpose: 'signup',
        })
      ).status,
    ).toBe(200);
  });

  it('a login code for an existing account signs in and sends the new-sign-in email', async () => {
    const user = await makeUser('logincode');
    const req = await post('code/request', {
      email: email('logincode'),
      purpose: 'login',
    });
    expect(req.status).toBe(200);
    const sent = await waitForMail(email('logincode'), MailEvent.AUTH_CODE);
    expect(sent.data).toMatchObject({
      heading: 'Your sign-in code',
      expiresInMinutes: 10,
    });

    const res = await request(server())
      .post('/api/v1/auth/code/verify')
      .set(
        'User-Agent',
        'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      )
      .send({
        email: email('logincode'),
        code: String(sent.data.code),
        purpose: 'login',
      });
    expect(res.status).toBe(200);
    expect((res.body as Body).data).toMatchObject({ id: user.id });
    expect(setCookies(res)[REFRESH]).toBeDefined();
    const notice = await waitForMail(
      email('logincode'),
      MailEvent.AUTH_NEW_SIGN_IN,
    );
    expect(notice.data).toMatchObject({
      device: 'Chrome on Windows',
      method: 'Email code',
    });
  });

  it('a login code for an unknown address: same status and body, no mail, no row', async () => {
    await makeUser('known');
    const known = await post('code/request', {
      email: email('known'),
      purpose: 'login',
    });
    const unknown = await post('code/request', {
      email: email('nobody'),
      purpose: 'login',
    });

    expect(unknown.status).toBe(known.status);
    const normalise = (b: Body) => ({
      ...b,
      data: { ...b.data, resendAvailableAt: 'T' },
    });
    expect(normalise(unknown.body as Body)).toEqual(
      normalise(known.body as Body),
    );
    for (const r of [known, unknown]) {
      const at = Date.parse(String((r.body as Body).data?.resendAvailableAt));
      expect(Math.abs(at - (Date.now() + 60_000))).toBeLessThan(5_000);
    }
    await waitForMail(email('known'), MailEvent.AUTH_CODE);
    await new Promise((r) => setTimeout(r, 100));
    expect(mailsTo(email('nobody'))).toHaveLength(0);

    // Verifying against the unknown address answers exactly like a wrong code.
    const v = await post('code/verify', {
      email: email('nobody'),
      code: '123456',
      purpose: 'login',
    });
    expect(v.status).toBe(400);
    expect((v.body as Body).meta?.error).toBe('CODE_INVALID');

    // Both hit the same cooldown.
    const k2 = await post('code/request', {
      email: email('known'),
      purpose: 'login',
    });
    const u2 = await post('code/request', {
      email: email('nobody'),
      purpose: 'login',
    });
    expect([k2.status, u2.status]).toEqual([429, 429]);
    expect((k2.body as Body).meta?.error).toBe('AUTH_RATE_LIMIT_EXCEEDED');
    expect((u2.body as Body).meta?.error).toBe('AUTH_RATE_LIMIT_EXCEEDED');
    expect((u2.body as Body).meta?.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('forgot → reset with the code → signed in, and the old refresh token is rejected', async () => {
    const user = await makeUser('reset');
    const login = await post('login', {
      email: email('reset'),
      password: PASSWORD,
    });
    expect(login.status).toBe(200);
    const oldRefresh = cookieValue(setCookies(login)[REFRESH]);

    const knownForgot = await post('password/forgot', {
      email: email('reset'),
    });
    const unknownForgot = await post('password/forgot', {
      email: email('reset-nobody'),
    });
    expect(knownForgot.status).toBe(200);
    expect(unknownForgot.status).toBe(200);
    expect(Object.keys((unknownForgot.body as Body).data ?? {})).toEqual([
      'resendAvailableAt',
    ]);
    expect((unknownForgot.body as Body).message).toBe(
      (knownForgot.body as Body).message,
    );

    const sent = await waitForMail(email('reset'), MailEvent.AUTH_CODE);
    expect(sent.data).toMatchObject({ heading: 'Reset your password' });

    // A reset code can't be used to log in.
    expect(
      (
        (
          await post('code/verify', {
            email: email('reset'),
            code: String(sent.data.code),
            purpose: 'login',
          })
        ).body as Body
      ).meta?.error,
    ).toBe('CODE_INVALID');

    // The code can be checked first without using it up.
    const check = await post('password/reset/check', {
      email: email('reset'),
      code: String(sent.data.code),
    });
    expect(check.status).toBe(200);
    expect((check.body as Body).data).toEqual({ valid: true });
    const badCheck = await post('password/reset/check', {
      email: email('reset'),
      code: String(sent.data.code) === '000000' ? '111111' : '000000',
    });
    expect((badCheck.body as Body).meta?.error).toBe('CODE_INVALID');

    const reset = await post('password/reset', {
      email: email('reset'),
      code: String(sent.data.code),
      newPassword: NEW_PASSWORD,
    });
    expect(reset.status).toBe(200);
    expect((reset.body as Body).access_token).toEqual(expect.any(String));
    const newRefresh = cookieValue(setCookies(reset)[REFRESH]);
    expect(newRefresh).toBeDefined();

    const replay = await request(server())
      .post('/api/v1/auth/refresh-token')
      .set('Cookie', `${REFRESH}=${oldRefresh}`);
    expect(replay.status).toBe(400);
    const fresh = await request(server())
      .post('/api/v1/auth/refresh-token')
      .set('Cookie', `${REFRESH}=${newRefresh}`);
    expect(fresh.status).toBe(200);

    expect(
      (await post('login', { email: email('reset'), password: PASSWORD }))
        .status,
    ).toBe(401);
    expect(
      (await post('login', { email: email('reset'), password: NEW_PASSWORD }))
        .status,
    ).toBe(200);
    await waitForMail(email('reset'), MailEvent.AUTH_PASSWORD_CHANGED);
    const names = (await events(user.id)).map((e) => e.event);
    expect(names).toContain('auth.password_reset');
  });

  it('an existing address at sign-up: identical 201, nothing created, the owner is told', async () => {
    const owner = await makeUser('taken');
    const before = await userRepo.count();
    const fresh = await post('register', registerBody('taken-fresh'));
    const taken = await post(
      'register',
      registerBody('taken', { email: email('taken') }),
    );

    expect(taken.status).toBe(fresh.status);
    expect(taken.status).toBe(201);
    expect(Object.keys(taken.body as object)).toEqual(
      Object.keys(fresh.body as object),
    );
    expect((taken.body as Body).message).toBe((fresh.body as Body).message);
    expect(Object.keys((taken.body as Body).data!)).toEqual([
      'email',
      'resendAvailableAt',
    ]);
    expect(await userRepo.count()).toBe(before + 1);

    const notice = await waitForMail(
      owner.email,
      MailEvent.AUTH_SIGNUP_ATTEMPT,
    );
    expect(notice.data).not.toHaveProperty('code');
    expect(mailsTo(owner.email, MailEvent.AUTH_CODE)).toHaveLength(0);
  });

  it('a phone number already in use keeps its explicit 409', async () => {
    const holder = await makeUser('phoneholder');
    const res = await post(
      'register',
      registerBody('phoneclash', { phoneNumber: holder.phoneNumber }),
    );
    expect(res.status).toBe(409);
    expect((res.body as Body).meta?.error).toBe('PHONE_NUMBER_IN_USE');
  });

  it('old clients still sending username and gender keep working', async () => {
    const res = await post(
      'register',
      registerBody('oldclient', {
        username: `old.client${tail}`,
        gender: 'FEMALE',
        firstname: 'Ama',
      }),
    );
    expect(res.status).toBe(201);
    const user = await userRepo.findOneByOrFail({ email: email('oldclient') });
    expect(user.username).toBe(`old.client${tail}`);
    expect(user.gender).toBe('FEMALE');

    // A taken username from an old client is swapped for a generated one.
    const again = await post(
      'register',
      registerBody('oldclient2', {
        username: `OLD.client${tail}`,
        firstname: 'Ama',
        lastname: 'Mensah',
      }),
    );
    expect(again.status).toBe(201);
    const second = await userRepo.findOneByOrFail({
      email: email('oldclient2'),
    });
    expect(second.username).toMatch(/^ama\.mensah\d*$/);

    // An invalid one is still refused by the rule.
    expect(
      (
        await post(
          'register',
          registerBody('oldbad', { username: 'has space' }),
        )
      ).status,
    ).toBe(400);
  });

  it('generated usernames count up on collision: first.last, first.last2, first.last3', async () => {
    const names: string[] = [];
    for (const label of ['dup1', 'dup2', 'dup3']) {
      await post(
        'register',
        registerBody(label, {
          firstname: 'Yaw',
          lastname: `Dúplicate${tail.replace(/\d/g, (d) => 'abcdefghij'[Number(d)])}`,
        }),
      ).expect(201);
      names.push(
        (await userRepo.findOneByOrFail({ email: email(label) })).username,
      );
    }
    const base = names[0];
    expect(names).toEqual([base, `${base}2`, `${base}3`]);
    for (const n of names) expect(n).toMatch(VARIABLES.USERNAME_REGEX);
  });

  it('ADMIN is still rejected at sign-up', async () => {
    const res = await post(
      'register',
      registerBody('admin', { role: 'ADMIN' }),
    );
    expect(res.status).toBe(400);
    expect(await userRepo.count({ where: { email: email('admin') } })).toBe(0);
  });

  it('usernames are editable through PATCH /users/me, and unique', async () => {
    const a = await makeUser('renamea');
    const b = await makeUser('renameb');
    const login = await post('login', {
      email: email('renamea'),
      password: PASSWORD,
    });
    const token = (login.body as Body).access_token!;
    const patch = (username: string) =>
      request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ username });

    const taken = await patch(b.username.toUpperCase());
    expect(taken.status).toBe(409);
    expect((taken.body as Body).meta?.error).toBe('USERNAME_TAKEN');
    expect((await patch(`kofi.new${tail}`)).status).toBe(200);
    expect((await userRepo.findOneByOrFail({ id: a.id })).username).toBe(
      `kofi.new${tail}`,
    );
  });

  it('Google complete-signup needs only a phone number', async () => {
    const pending = app.get(PendingSocialSignupService);
    const key = pending.create({
      email: email('google'),
      firstname: 'Abena',
      lastname: 'Google',
      provider: 'google',
      providerId: `av2-google-${uniq}`,
      suggestedRole: Role.ARTISAN,
    });
    const res = await request(server())
      .post('/api/v1/auth/social/complete')
      .set('Cookie', `${VARIABLES.PENDING_SOCIAL_SIGNUP_COOKIE_NAME}=${key}`)
      .send({ phoneNumber: phone() });
    expect(res.status).toBe(200);
    expect((res.body as Body).data).toMatchObject({ role: Role.ARTISAN });
    const user = await userRepo.findOneByOrFail({ email: email('google') });
    expect(user.username).toMatch(/^abena\.google\d*$/);
    expect(user.gender).toBeNull();
    expect(user.accountVerified).toBe(true);

    // An old client sending gender and the artisan details still works.
    const key2 = pending.create({
      email: email('google-old'),
      firstname: 'Kojo',
      lastname: 'Google',
      provider: 'google',
      providerId: `av2-google-old-${uniq}`,
    });
    const old = await request(server())
      .post('/api/v1/auth/social/complete')
      .set('Cookie', `${VARIABLES.PENDING_SOCIAL_SIGNUP_COOKIE_NAME}=${key2}`)
      .send({
        role: 'CUSTOMER',
        firstname: 'Kojo',
        lastname: 'Google',
        gender: 'MALE',
        phoneNumber: phone(),
      });
    expect(old.status).toBe(200);
  });

  it('old /auth/verify-email links keep working until they expire', async () => {
    const user = await makeUser('oldlink', {
      accountVerified: false,
      verifiedAt: null as unknown as Date,
    });
    const token = await app
      .get(UserTokenService)
      .createToken(
        user,
        Token.EMAIL_VERIFICATION,
        VARIABLES.EMAIL_VERIFICATION_TOKEN_EXPIRES_IN_MINUTES,
      );
    const res = await post('verify-email', { token: token.token });
    expect(res.status).toBe(200);
    expect(
      (await userRepo.findOneByOrFail({ id: user.id })).accountVerified,
    ).toBe(true);
  });

  it('an unconfirmed account asking for a login code gets the sign-up wording, and the code signs in', async () => {
    await post('register', registerBody('unconfirmed')).expect(201);
    await codeFor(email('unconfirmed'));
    await skipCooldown(email('unconfirmed'));
    await post('code/request', {
      email: email('unconfirmed'),
      purpose: 'login',
    }).expect(200);
    const sent = await waitForMail(
      email('unconfirmed'),
      MailEvent.AUTH_CODE,
      2,
    );
    expect(sent.data).toMatchObject({ heading: 'Confirm your email' });
    const res = await post('code/verify', {
      email: email('unconfirmed'),
      code: String(sent.data.code),
      purpose: 'login',
    });
    expect(res.status).toBe(200);
    expect(
      (await userRepo.findOneByOrFail({ email: email('unconfirmed') }))
        .accountVerified,
    ).toBe(true);
  });
});
