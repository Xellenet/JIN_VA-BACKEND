/**
 * Auth v2 with Turnstile configured, over real HTTP. Cloudflare is never
 * called: `fetch` to the siteverify URL is answered in-process (token
 * `pass-<action>` passes for that action; `cloudflare-down` simulates an
 * outage), and hermetic.ts refuses every other off-machine connection.
 *
 * - register, code/request and password/forgot need a passing token
 *   (400 TURNSTILE_FAILED otherwise, 503 TURNSTILE_UNAVAILABLE when Cloudflare
 *   is unreachable — fail-closed);
 * - password login asks for a token (401 TURNSTILE_REQUIRED) after 3
 *   failures for an email or an IP, and works again once one passes.
 *
 * Run: npm run test:e2e -- auth-v2-turnstile --runInBand
 */
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '10000';
process.env.AUTH_EMAIL_RATE_LIMIT_PER_MINUTE = '10000';
// Cloudflare's documented always-pass test secret; requests are answered locally.
process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';

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
import { VARIABLES } from '@common/constants/variables.constants';
import { Role } from '@common/types/enums';

jest.setTimeout(120000);

interface Body {
  meta?: { error?: string };
}

const PASSWORD = 'Fict1onal!Pass';

describe('Auth v2 — Turnstile enabled (e2e)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let userRepo: Repository<User>;
  let dataSource: DataSource;
  let fetchSpy: jest.SpyInstance;
  const uniq = Date.now();
  const tail = String(uniq).slice(-5);
  const email = (label: string) => `av2t-${label}-${uniq}@example.com`;
  const server = () => app.getHttpServer();
  const siteverifyCalls: URLSearchParams[] = [];

  beforeAll(async () => {
    const realFetch = globalThis.fetch;
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          if (url !== VARIABLES.TURNSTILE_SITEVERIFY_URL)
            return realFetch(input, init);
          const form = new URLSearchParams(init?.body as URLSearchParams);
          siteverifyCalls.push(form);
          const token = form.get('response') ?? '';
          if (token === 'cloudflare-down')
            return Promise.reject(new TypeError('fetch failed'));
          const action = token.startsWith('pass-') ? token.slice(5) : undefined;
          return Promise.resolve(
            new Response(
              JSON.stringify(
                action
                  ? { success: true, action, hostname: 'localhost' }
                  : {
                      success: false,
                      'error-codes': ['invalid-input-response'],
                    },
              ),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        },
      );

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
  });

  afterAll(async () => {
    const rows: Array<{ id: number }> = await dataSource.query(
      `SELECT "id" FROM "users" WHERE "email" LIKE $1`,
      [`av2t-%-${uniq}@example.com`],
    );
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      for (const table of [
        'auth_codes',
        'account_security_events',
        'user_tokens',
        'notification_preferences',
        'customer_profiles',
      ]) {
        await dataSource
          .query(`DELETE FROM ${table} WHERE user_id = ANY($1)`, [ids])
          .catch(() => undefined);
      }
      await dataSource.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
    }
    fetchSpy.mockRestore();
    delete process.env.TURNSTILE_SECRET_KEY;
    await app.close();
  });

  const post = (path: string, body: Record<string, unknown>, ip?: string) => {
    const r = request(server()).post(`/api/v1/auth/${path}`);
    return (ip ? r.set('X-Forwarded-For', ip) : r).send(body);
  };
  const register = (label: string, token?: string) =>
    post('register', {
      email: email(label),
      password: PASSWORD,
      firstname: 'Ama',
      lastname: 'Turnstile',
      phoneNumber: `+23324${String(label.length).padStart(2, '0')}${tail}`,
      role: 'CUSTOMER',
      ...(token !== undefined ? { turnstileToken: token } : {}),
    });

  it('register needs a passing token for the register action', async () => {
    const missing = await register('reg-missing');
    expect(missing.status).toBe(400);
    expect((missing.body as Body).meta?.error).toBe('TURNSTILE_FAILED');

    const wrongAction = await register('reg-wrong', 'pass-login');
    expect((wrongAction.body as Body).meta?.error).toBe('TURNSTILE_FAILED');
    expect(await userRepo.count({ where: { email: email('reg-wrong') } })).toBe(
      0,
    );

    const ok = await register('reg-ok', 'pass-register');
    expect(ok.status).toBe(201);
    const last = siteverifyCalls[siteverifyCalls.length - 1];
    expect(last.get('secret')).toBe(process.env.TURNSTILE_SECRET_KEY);
    expect(last.get('response')).toBe('pass-register');
    expect(last.get('remoteip')).toBeTruthy();
  });

  it('is fail-closed: 503 TURNSTILE_UNAVAILABLE when Cloudflare cannot be reached, nothing created', async () => {
    const res = await register('reg-down', 'cloudflare-down');
    expect(res.status).toBe(503);
    expect((res.body as Body).meta?.error).toBe('TURNSTILE_UNAVAILABLE');
    expect(await userRepo.count({ where: { email: email('reg-down') } })).toBe(
      0,
    );
  });

  it('code requests and forgot password need their own action', async () => {
    expect(
      (
        (await post('code/request', { email: email('x'), purpose: 'login' }))
          .body as Body
      ).meta?.error,
    ).toBe('TURNSTILE_FAILED');
    expect(
      (
        await post('code/request', {
          email: email('x'),
          purpose: 'login',
          turnstileToken: 'pass-code_request',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        (
          await post('password/forgot', {
            email: email('x'),
            turnstileToken: 'pass-code_request',
          })
        ).body as Body
      ).meta?.error,
    ).toBe('TURNSTILE_FAILED');
    expect(
      (
        await post('password/forgot', {
          email: email('x'),
          turnstileToken: 'pass-forgot',
        })
      ).status,
    ).toBe(200);
  });

  it('login asks for Turnstile after 3 failures for an email, until a token passes', async () => {
    await userRepo.save(
      userRepo.create({
        email: email('login'),
        password: await bcrypt.hash(PASSWORD, 4),
        firstname: 'Esi',
        lastname: 'Login',
        username: `av2t.login${tail}`,
        role: Role.CUSTOMER,
        accountVerified: true,
        verifiedAt: new Date(),
      }),
    );
    for (let i = 0; i < 3; i++) {
      const res = await post('login', {
        email: email('login'),
        password: 'Wrong#Pass9',
      });
      expect(res.status).toBe(401);
      expect((res.body as Body).meta?.error).not.toBe('TURNSTILE_REQUIRED');
    }
    const blocked = await post('login', {
      email: email('login'),
      password: PASSWORD,
    });
    expect(blocked.status).toBe(401);
    expect((blocked.body as Body).meta?.error).toBe('TURNSTILE_REQUIRED');

    const badToken = await post('login', {
      email: email('login'),
      password: PASSWORD,
      turnstileToken: 'nope',
    });
    expect((badToken.body as Body).meta?.error).toBe('TURNSTILE_REQUIRED');

    const ok = await post('login', {
      email: email('login'),
      password: PASSWORD,
      turnstileToken: 'pass-login',
    });
    expect(ok.status).toBe(200);
  });

  it('asks for it after 3 failures from one IP too, for an address with no account', async () => {
    for (const n of [1, 2, 3]) {
      await post('login', {
        email: email(`nobody${n}`),
        password: 'Wrong#Pass9',
      });
    }
    const res = await post('login', {
      email: email('nobody4'),
      password: 'Wrong#Pass9',
    });
    expect((res.body as Body).meta?.error).toBe('TURNSTILE_REQUIRED');
  });
});
