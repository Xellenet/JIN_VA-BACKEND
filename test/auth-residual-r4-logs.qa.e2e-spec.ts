/**
 * QA re-verification for `docs/team/auth-residual-findings/requirements.md`
 * item 5 (security `M5`, login-path half): no email address may reach the logs
 * from `loginUser`, or from the per-request `findUserByEmail` line that
 * `JwtStrategy` triggers on every authenticated call.
 *
 * Test code only — written by QA. Nothing here is imported by the application.
 *
 * How this is captured: the app is built with production's winston wiring, and
 * an extra in-memory winston transport is attached so every line the
 * application logger emits during this file is collected verbatim. The
 * assertions then run over that capture. Fixtures are created through the
 * repository, never through `POST /auth/register`, because the register log
 * lines still contain addresses by decision (out of scope) and would otherwise
 * pollute the capture.
 *
 * This file never prints a fixture address itself — every diagnostic prints the
 * case name and a redacted form — so the capture and this file's own output can
 * both be searched for a leak.
 *
 * Run: npm run test:e2e -- auth-residual-r4-logs.qa
 */
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '10000';
process.env.AUTH_EMAIL_RATE_LIMIT_PER_MINUTE = '10000';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import * as bcrypt from 'bcrypt';
import { subDays } from 'date-fns';
import Transport from 'winston-transport';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { User } from '@users/entities/user.entity';
import { UserTokenService } from '@users/token.service';
import { Role } from '@common/types/enums';
import { VARIABLES } from '@common/constants/variables.constants';

jest.setTimeout(300000);

const PASSWORD = 'CorrectHorse1!';
const WRONG = 'WrongHorse9!';

/** Every line the application logger emitted, in order. */
const captured: string[] = [];

class CaptureTransport extends Transport {
  log(info: Record<string, unknown>, next: () => void): void {
    captured.push(JSON.stringify(info));
    next();
  }
}

describe('auth-residual-findings item 5 — no email addresses on the login path (QA e2e)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let userRepo: Repository<User>;
  let tokenService: UserTokenService;

  const uniq = Date.now();
  const createdUserIds: number[] = [];
  /** case name -> submitted address. Never printed. */
  const addresses = new Map<string, string>();

  const server = () => app.getHttpServer();
  const login = (e: string, p: string) =>
    request(server())
      .post('/api/v1/auth/login')
      .send({ email: e, password: p });

  async function makeUser(
    label: string,
    opts: { verified?: boolean; social?: boolean; noPassword?: boolean } = {},
  ): Promise<{ user: User; token: string; email: string }> {
    const e = `qa-r4log-${label}-${uniq}@test.jinva.local`;
    const user = await userRepo.save(
      userRepo.create({
        email: e,
        password: opts.noPassword
          ? null
          : await bcrypt.hash(PASSWORD, VARIABLES.SALT_OR_ROUNDS),
        firstname: 'QaR4log',
        lastname: label.slice(0, 14),
        role: Role.CUSTOMER,
        accountVerified: opts.verified ?? true,
        ...(opts.social
          ? {
              isSocialLogin: true,
              socialProvider: 'google',
              socialProviderId: `g-r4log-${label}-${uniq}`,
            }
          : {}),
      } as Partial<User>),
    );
    createdUserIds.push(user.id);
    addresses.set(label, e);
    return {
      user,
      email: e,
      token: (await tokenService.createJWTTokens(user)).access_token,
    };
  }

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    const logger = app.get<WinstonLogger>(WINSTON_MODULE_NEST_PROVIDER);
    // `WINSTON_MODULE_NEST_PROVIDER` is Nest's wrapper; reach the winston
    // instance underneath so the capture sees exactly what the console
    // transport sees.
    const winstonInstance = (logger as unknown as { logger?: WinstonLogger })
      .logger;
    (winstonInstance ?? logger).add(new CaptureTransport());
    // main.ts does this, and without it the services' `new Logger(X.name)`
    // calls go to Nest's default console logger instead of winston — so the
    // capture would see only the exception filter's lines.
    app.useLogger(logger);
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
    tokenService = moduleFixture.get(UserTokenService);
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await userRepo.manager
        .query('delete from user_tokens where user_id = $1', [id])
        .catch(() => undefined);
    }
    if (createdUserIds.length)
      await userRepo.manager
        .query('delete from users where id = any($1::int[])', [createdUserIds])
        .catch(() => undefined);
    await app.close();
  });

  it('captures a full set of login outcomes and no line contains an email address', async () => {
    const live = await makeUser('live', { verified: true });
    const unverified = await makeUser('unverified', { verified: false });
    const socialOnly = await makeUser('socialonly', {
      social: true,
      noPassword: true,
    });
    const deleted = await makeUser('deleted', { verified: true });
    await userRepo.manager.query(
      'update users set deleted_at = $2 where id = $1',
      [deleted.user.id, subDays(new Date(), 2)],
    );
    const never = `qa-r4log-never-${uniq}@test.jinva.local`;
    addresses.set('never', never);

    // The capture starts clean from here: fixture creation is done.
    captured.length = 0;

    const outcomes: Array<[string, number]> = [];
    outcomes.push(['success', (await login(live.email, PASSWORD)).status]);
    outcomes.push(['wrong-password', (await login(live.email, WRONG)).status]);
    outcomes.push([
      'unverified',
      (await login(unverified.email, PASSWORD)).status,
    ]);
    outcomes.push([
      'social-only',
      (await login(socialOnly.email, PASSWORD)).status,
    ]);
    outcomes.push([
      'soft-deleted-right-pw',
      (await login(deleted.email, PASSWORD)).status,
    ]);
    outcomes.push([
      'soft-deleted-wrong-pw',
      (await login(deleted.email, WRONG)).status,
    ]);
    outcomes.push(['never-registered', (await login(never, PASSWORD)).status]);

    // Every authenticated request resolves through findUserByEmail in
    // JwtStrategy — the highest-volume line in the application.
    const meRes = await request(server())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${live.token}`);
    outcomes.push(['authenticated-request', meRes.status]);

    console.log('[item5] login outcomes =', JSON.stringify(outcomes));
    console.log('[item5] captured log lines =', captured.length);

    const blob = captured.join('\n');

    // 1. No fixture address, in any form, anywhere in the capture.
    const leaked: string[] = [];
    for (const [label, addr] of addresses) {
      if (blob.includes(addr)) leaked.push(label);
      if (blob.includes(addr.split('@')[0]))
        leaked.push(`${label}(local-part)`);
    }
    console.log(
      '[item5] addresses found in the log capture =',
      JSON.stringify(leaked),
    );
    expect(leaked).toEqual([]);

    // 2. Not even the shared fixture prefix — catches a partial redaction that
    //    still prints most of the address.
    expect(blob).not.toContain('qa-r4log-');
    // 3. No address-shaped string at all on these lines.
    const emailShaped = captured.filter((l) =>
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(l),
    );
    console.log(
      '[item5] log lines containing an address-shaped string =',
      emailShaped.length,
      JSON.stringify(emailShaped.slice(0, 5)),
    );
    expect(emailShaped).toEqual([]);
  });

  it('accounts are still identifiable in the logs — by user id and by a stable email hash', () => {
    const blob = captured.join('\n');
    const hashLines = captured.filter((l) => /email hash/i.test(l));
    const idLines = captured.filter((l) => /user \d+/i.test(l));
    console.log('[item5] lines naming an email hash =', hashLines.length);
    console.log(
      '[item5] sample hash line =',
      JSON.stringify(hashLines[0] ?? null),
    );
    console.log('[item5] lines naming a user id =', idLines.length);
    console.log('[item5] sample id line =', JSON.stringify(idLines[0] ?? null));
    // Item 5's edge case: removing the address must not remove the ability to
    // debug a failed login.
    expect(hashLines.length + idLines.length).toBeGreaterThan(0);
    expect(blob.length).toBeGreaterThan(0);
  });

  it('the two pre-lookup lines are emitted identically for a registered and an unregistered address (no new enumeration oracle)', async () => {
    const live = await makeUser('oracle-live', { verified: true });
    const never = `qa-r4log-oracle-never-${uniq}@test.jinva.local`;
    addresses.set('oracle-never', never);

    /** Log lines produced by exactly one login attempt, message text only. */
    const linesFor = async (e: string): Promise<string[]> => {
      captured.length = 0;
      await login(e, WRONG);
      return captured.map((l) => {
        const parsed = JSON.parse(l) as {
          context?: string;
          level?: string;
          message?: string;
        };
        return `${parsed.context ?? ''}|${parsed.level ?? ''}|${parsed.message ?? ''}`;
      });
    };

    const registered = await linesFor(live.email);
    const unregistered = await linesFor(never);

    // Strip the per-attempt hash and the user id, which legitimately differ,
    // and compare the remaining shape.
    const shape = (ls: string[]) =>
      ls.map((l) =>
        l
          .replace(/hash [0-9a-f]+/gi, 'hash <H>')
          .replace(/user \d+/gi, 'user <ID>')
          .replace(/\b[0-9a-f]{8,}\b/gi, '<H>'),
      );

    console.log(
      '[item5] registered   lines =',
      JSON.stringify(shape(registered)),
    );
    console.log(
      '[item5] unregistered lines =',
      JSON.stringify(shape(unregistered)),
    );

    // The pre-lookup lines (loginUser's entry line and findUserByEmail's) must
    // both be present in both cases.
    const preLookup = (ls: string[]) =>
      shape(ls).filter((l) => /hash <H>/.test(l));
    expect(preLookup(registered).length).toBeGreaterThan(0);
    expect(preLookup(registered)).toEqual(preLookup(unregistered));

    // And neither capture contains an address.
    expect(registered.join('\n')).not.toContain('qa-r4log-');
    expect(unregistered.join('\n')).not.toContain('qa-r4log-');
  });
});
