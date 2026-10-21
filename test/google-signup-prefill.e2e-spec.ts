/**
 * End-to-end verification of the backend half of google-signup-prefill
 * (docs/team/google-signup-prefill/requirements.md in the frontend repo):
 *
 * - PH2/PH6/PH7/PH9: phone input in national / `+CC` / `00CC` form is stored
 *   as E.164 on every write path (`POST /auth/register`, `PATCH /users/me`,
 *   admin `POST /users`); numbers invalid for their country or from an
 *   unsupported country are rejected; a duplicate gives
 *   `meta.error = PHONE_NUMBER_IN_USE`, whatever form it was typed in.
 * - DI5: `/auth/register` requires phone + gender; `OTHER` is rejected as
 *   input everywhere, while an existing `OTHER` row still reads back.
 * - B2/B5: an artisan with rate + location + services and **no bio** is
 *   complete, has no `bio` in `missingFields`, and is listed by `GET /artisans`.
 * - LOC10/LOC8/R17/PR1/PR2/PR5: `GET /locations/suggestions` against an
 *   in-process Photon mock — documented shape, filtering, cache, graceful
 *   degradation, throttle, and an upstream request that carries only the
 *   query, the country and the fixed params with the JinVa User-Agent.
 * - PH10: the E.164 migration is exercised inside a transaction that is
 *   always rolled back (down → up round trip, collision abort, unparseable
 *   rows left alone), so the dev database is never changed by it.
 *
 * Isolation (test process only — nothing here reads or edits `.env`):
 * - Photon: `PHOTON_BASE_URL` points at a local HTTP server; no request can
 *   reach photon.komoot.io.
 * - Storage: `STORAGE_PROVIDER=local`; no upload is made anyway.
 * - Mail: `MailService` is replaced by a stub, so no email is ever sent.
 *
 * Every row this file creates uses `@example.com` addresses with a per-run
 * tag and is deleted in `afterAll`.
 *
 * Run: npm run test:e2e -- google-signup-prefill --runInBand
 */
process.env.STORAGE_PROVIDER = 'local';
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '10000';
process.env.AUTH_EMAIL_RATE_LIMIT_PER_MINUTE = '10000';
process.env.LOCATION_SUGGESTIONS_RATE_LIMIT_PER_MINUTE = '10000';
// Replaced by the mock server's address in `beforeAll`, before the app is
// compiled; this value only guarantees nothing real is reachable meanwhile.
process.env.PHOTON_BASE_URL = 'http://photon.invalid';

import { createServer, IncomingHttpHeaders, Server } from 'http';
import type { AddressInfo } from 'net';
import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  Logger,
  LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { DataSource, In, Like, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcrypt';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { LocationsModule } from '../src/locations/locations.module';
import { LocationsService } from '../src/locations/locations.service';
import { PHOTON_USER_AGENT } from '../src/locations/locations.constants';
import { NormalizePhoneNumbersToE1641783230000000 } from '../src/migrations/1783230000000-NormalizePhoneNumbersToE164';
import { PHONE_NUMBER_FIXTURES } from '../src/common/utils/phone-number.fixtures';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { CustomerProfile } from '@users/entities/customer-profile.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { UserTokenService } from '@users/token.service';
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';
import { Gender, Role } from '@common/types/enums';

jest.setTimeout(120000);

interface Body {
  status?: string;
  message?: string | string[];
  data?: unknown;
  meta?: {
    error?: string;
    statusCode?: number;
    path?: string;
    timestamp?: string;
    retryAfterSeconds?: number;
  };
}

interface SuggestionsBody extends Body {
  data: {
    suggestions: Array<{
      name: string;
      region: string | null;
      city?: string;
      countryCode: string;
    }>;
    available: boolean;
  };
}

// ─── Photon mock ────────────────────────────────────────────────────────────

type PhotonMode = 'ok' | 'error500' | 'rate429' | 'slow' | 'badPayload';

interface PhotonCall {
  method: string;
  path: string;
  params: Array<[string, string]>;
  headers: IncomingHttpHeaders;
}

const photon = {
  mode: 'ok' as PhotonMode,
  calls: [] as PhotonCall[],
  server: undefined as Server | undefined,
  baseUrl: '',
};

const feature = (properties: Record<string, unknown>) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [0, 0] },
  properties,
});

/** Fictional-enough place rows exercising every R17/LOC10 mapping rule. */
const PHOTON_FEATURES = [
  feature({
    name: 'East Legon',
    osm_key: 'place',
    osm_value: 'suburb',
    city: 'Accra',
    state: 'Greater Accra Region',
    countrycode: 'GH',
  }),
  feature({
    name: 'Legon Power Plant',
    osm_key: 'power',
    osm_value: 'plant',
    city: 'Accra',
    state: 'Greater Accra',
    countrycode: 'GH',
  }),
  feature({
    name: 'Legon',
    osm_key: 'place',
    osm_value: 'suburb',
    city: 'Accra',
    state: 'Greater Accra',
    countrycode: 'GH',
  }),
  // Exact duplicate of the row above: dropped.
  feature({
    name: 'Legon',
    osm_key: 'place',
    osm_value: 'suburb',
    city: 'Accra',
    state: 'Greater Accra',
    countrycode: 'GH',
  }),
  // No name: dropped.
  feature({
    name: '',
    osm_key: 'place',
    osm_value: 'town',
    state: 'Ashanti',
    countrycode: 'GH',
  }),
  // Other country: dropped.
  feature({
    name: 'Testville Across',
    osm_key: 'place',
    osm_value: 'city',
    state: 'Maritime',
    countrycode: 'TG',
  }),
  feature({
    name: 'Nhyiaeso',
    osm_key: 'place',
    osm_value: 'suburb',
    city: 'Kumasi',
    state: 'Ashanti Region',
    countrycode: 'GH',
  }),
  // City equal to name: `city` omitted.
  feature({
    name: 'Kumasi',
    osm_key: 'place',
    osm_value: 'city',
    city: 'Kumasi',
    state: 'Ashanti',
    countrycode: 'GH',
  }),
  feature({
    name: 'Tema',
    osm_key: 'boundary',
    osm_value: 'administrative',
    state: 'Greater Accra',
    countrycode: 'gh',
  }),
  feature({
    name: 'Sample Residential Area',
    osm_key: 'landuse',
    osm_value: 'residential',
    state: 'Greater Accra',
    countrycode: 'GH',
  }),
  // A facility tag: dropped.
  feature({
    name: 'Sample Flour Mill',
    osm_key: 'man_made',
    osm_value: 'works',
    state: 'Greater Accra',
    countrycode: 'GH',
  }),
  ...['A', 'B', 'C', 'D'].map((s) =>
    feature({
      name: `Madina ${s}`,
      osm_key: 'place',
      osm_value: 'village',
      state: 'Volta',
      countrycode: 'GH',
    }),
  ),
];

function startPhotonMock(): Promise<void> {
  photon.server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock.local');
    photon.calls.push({
      method: req.method ?? '',
      path: url.pathname,
      params: [...url.searchParams.entries()],
      headers: req.headers,
    });
    const send = (status: number, body: unknown, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    switch (photon.mode) {
      case 'error500':
        return send(500, { message: 'upstream exploded' });
      case 'rate429':
        return send(429, { message: 'slow down' }, { 'Retry-After': '1' });
      case 'badPayload':
        return send(200, { notFeatures: true });
      case 'slow':
        setTimeout(
          () => send(200, { features: PHOTON_FEATURES }),
          2_500,
        ).unref();
        return;
      default:
        return send(200, {
          type: 'FeatureCollection',
          features: PHOTON_FEATURES,
        });
    }
  });
  return new Promise((resolve) => {
    photon.server!.listen(0, '127.0.0.1', () => {
      const { port } = photon.server!.address() as AddressInfo;
      photon.baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

// ─── suite ──────────────────────────────────────────────────────────────────

describe('google-signup-prefill backend (e2e)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let userRepo: Repository<User>;
  let artisanProfileRepo: Repository<ArtisanProfile>;
  let customerProfileRepo: Repository<CustomerProfile>;
  let serviceRepo: Repository<ServiceEntity>;
  let tokenService: UserTokenService;
  let locationsService: LocationsService;
  let service: ServiceEntity;
  const sendMail = jest.fn<Promise<void>, unknown[]>(() => Promise.resolve());

  /** Everything any logger was asked to write, for the PR5 assertions. */
  const logged: string[] = [];
  const recordLog = (...args: unknown[]) => {
    logged.push(
      args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' '),
    );
  };

  const uniq = Date.now();
  const TAG = `gsp${uniq}`;
  const PASSWORD = 'Sample@123x';
  const server = () => app.getHttpServer();
  const email = (label: string) => `${TAG}-${label}@example.com`;
  /** 7 per-run digits; `seq` makes every generated number distinct. */
  const base7 = Number(String(uniq).slice(-7));
  let seq = 0;
  const digits7 = () => String((base7 + (seq += 1)) % 1e7).padStart(7, '0');
  /** A per-run unique, valid Ghana mobile number in E.164 (`+23324` + 7). */
  const gh = () => `+23324${digits7()}`;
  const nsn = (e164: string) => e164.slice(4); // GH only
  const asNational = (e164: string) => {
    const n = nsn(e164);
    return `0${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5)}`;
  };
  const asInternational = (e164: string) => {
    const n = nsn(e164);
    return `+233 ${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5)}`;
  };
  const as00 = (e164: string) => `00233${nsn(e164)}`;
  /** A valid Nigerian mobile (`+234803` + 7 unique digits). */
  const ng = () => `+234803${digits7()}`;

  const messages = (res: request.Response): string[] => {
    const m = (res.body as Body).message;
    return Array.isArray(m) ? m : m ? [m] : [];
  };

  const registerBody = (overrides: Record<string, unknown> = {}) => {
    seq += 1;
    return {
      email: email(`reg${seq}`),
      password: PASSWORD,
      username: `${TAG}u${seq}`,
      firstname: 'Esi',
      lastname: 'Sample',
      phoneNumber: asNational(gh()),
      gender: 'FEMALE',
      role: Role.CUSTOMER,
      ...overrides,
    };
  };
  const register = (body: Record<string, unknown>) =>
    request(server()).post('/api/v1/auth/register').send(body);

  async function makeUser(
    label: string,
    role: Role,
    extra: Partial<User> = {},
  ): Promise<{ user: User; token: string }> {
    const user = await userRepo.save(
      userRepo.create({
        email: email(label),
        password: await bcrypt.hash(PASSWORD, 4),
        firstname: 'Kojo',
        lastname: 'Demo',
        role,
        accountVerified: true,
        isBanned: false,
        isSuspended: false,
        isSocialLogin: false,
        ...extra,
      } as Partial<User>),
    );
    return {
      user,
      token: (await tokenService.createJWTTokens(user)).access_token,
    };
  }
  const suggest = (query: Record<string, string>) =>
    request(server()).get('/api/v1/locations/suggestions').query(query);
  /** Ends any upstream cooldown (R10) without rebooting the app. */
  const resetLocationState = () => {
    (
      locationsService as unknown as { upstreamUnavailableUntil: number }
    ).upstreamUnavailableUntil = 0;
  };

  beforeAll(async () => {
    await startPhotonMock();
    process.env.PHOTON_BASE_URL = photon.baseUrl;

    moduleFixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailService)
      .useValue({ sendMail })
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

    // PR5 capture: the Nest logger (static + instance) and the winston logger.
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(recordLog);
      jest.spyOn(Logger, level).mockImplementation(recordLog);
      const w = logger as unknown as LoggerService;
      if (typeof w[level] === 'function') {
        jest.spyOn(w, level).mockImplementation(recordLog);
      }
    }
    for (const level of ['info', 'warn', 'error'] as const) {
      const w = logger as unknown as Record<string, unknown>;
      if (typeof w[level] === 'function') {
        jest
          .spyOn(logger as unknown as Record<string, () => void>, level)
          .mockImplementation(recordLog);
      }
    }

    dataSource = moduleFixture.get(DataSource);
    userRepo = moduleFixture.get(getRepositoryToken(User));
    artisanProfileRepo = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    customerProfileRepo = moduleFixture.get(
      getRepositoryToken(CustomerProfile),
    );
    serviceRepo = moduleFixture.get(getRepositoryToken(ServiceEntity));
    tokenService = moduleFixture.get(UserTokenService);
    locationsService = moduleFixture.get(LocationsService);
    service = await serviceRepo.save(
      serviceRepo.create({
        name: `GSP Service ${uniq}`,
        estimatedDurationMins: 60,
      }),
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    const mine = await userRepo.find({
      where: { email: Like(`${TAG}-%@example.com`) },
      withDeleted: true,
    });
    const ids = mine.map((u) => u.id);
    if (ids.length) {
      await artisanProfileRepo
        .createQueryBuilder()
        .delete()
        .where('user_id IN (:...ids)', { ids })
        .execute();
      await customerProfileRepo
        .createQueryBuilder()
        .delete()
        .where('user_id IN (:...ids)', { ids })
        .execute();
      await userRepo.delete({ id: In(ids) });
    }
    if (service) await serviceRepo.delete(service.id);
    const left = await userRepo.count({
      where: { email: Like(`${TAG}-%@example.com`) },
      withDeleted: true,
    });
    expect(left).toBe(0);
    await app.close();
    photon.server?.closeAllConnections();
    await new Promise((r) => photon.server?.close(r));
  });

  // ─── Phone + gender on POST /auth/register ────────────────────────────────

  describe('POST /auth/register — PH6/PH7/PH9, DI5', () => {
    it('the shared PH8 fixture table gives the same verdict through the API (validation only, nothing written)', async () => {
      // `username` is left out on purpose so every request is a 400 and no
      // row is ever written; only whether the phone message appears matters.
      const phoneMessages = [
        VALIDATION_MESSAGES.PHONE_NUMBER_INVALID,
        VALIDATION_MESSAGES.PHONE_NUMBER_REQUIRED,
        VALIDATION_MESSAGES.PHONE_NUMBER_MAX_LENGTH,
      ];
      // The API always reads national input as GH, so a national row for
      // another picker country isn't an API case.
      const rows = PHONE_NUMBER_FIXTURES.filter(
        (f) => f.country === 'GH' || f.input.trim().startsWith('+'),
      );
      expect(rows.length).toBeGreaterThanOrEqual(19);
      for (const f of rows) {
        const body: Record<string, unknown> = registerBody({
          phoneNumber: f.input,
        });
        delete body.username;
        const res = await register(body);
        expect(res.status).toBe(400);
        const phoneErrors = messages(res).filter((m) =>
          phoneMessages.includes(m),
        );
        expect({ input: f.input, rejected: phoneErrors.length > 0 }).toEqual({
          input: f.input,
          rejected: f.expected === null,
        });
        expect(
          await userRepo.count({ where: { email: body.email as string } }),
        ).toBe(0);
      }
    });

    it.each([
      ['national, spaced', asNational],
      ['international +233', asInternational],
      ['00 prefix', as00],
    ])(
      'accepts %s input and stores E.164',
      async (_label, form: (e: string) => string) => {
        const e164 = gh();
        const body = registerBody({ phoneNumber: form(e164) });
        const res = await register(body);
        expect(res.status).toBe(201);
        const row = await userRepo.findOne({
          where: { email: body.email },
        });
        expect(row!.phoneNumber).toBe(e164);
        expect(row!.gender).toBe(Gender.FEMALE);
        expect(JSON.stringify(res.body)).toContain(e164);
      },
    );

    it('accepts a valid number from another supported country (NG) and stores E.164', async () => {
      const e164 = ng();
      const n = e164.slice(4);
      const body = registerBody({
        phoneNumber: `+234 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`,
      });
      const res = await register(body);
      expect(res.status).toBe(201);
      const row = await userRepo.findOne({ where: { email: body.email } });
      expect(row!.phoneNumber).toBe(e164);
    });

    it('mail is stubbed: a successful registration reaches the stub, not a transport', () => {
      expect(sendMail).toHaveBeenCalled();
    });

    it.each([
      [
        'no phone',
        { phoneNumber: undefined },
        VALIDATION_MESSAGES.PHONE_NUMBER_REQUIRED,
      ],
      [
        'empty phone',
        { phoneNumber: '' },
        VALIDATION_MESSAGES.PHONE_NUMBER_REQUIRED,
      ],
      ['no gender', { gender: undefined }, VALIDATION_MESSAGES.GENDER_REQUIRED],
      ['gender OTHER', { gender: 'OTHER' }, VALIDATION_MESSAGES.GENDER_INVALID],
      [
        'gender lower-case',
        { gender: 'female' },
        VALIDATION_MESSAGES.GENDER_INVALID,
      ],
      [
        'US-style number',
        { phoneNumber: '123-456-7890' },
        VALIDATION_MESSAGES.PHONE_NUMBER_INVALID,
      ],
      [
        'GH too short',
        { phoneNumber: '024123456' },
        VALIDATION_MESSAGES.PHONE_NUMBER_INVALID,
      ],
      [
        'GH unassigned 025',
        { phoneNumber: '0251234567' },
        VALIDATION_MESSAGES.PHONE_NUMBER_INVALID,
      ],
      [
        'NG number too short',
        { phoneNumber: '+234 803 123 456' },
        VALIDATION_MESSAGES.PHONE_NUMBER_INVALID,
      ],
      [
        'unsupported +44',
        { phoneNumber: '+44 7911 123456' },
        VALIDATION_MESSAGES.PHONE_NUMBER_INVALID,
      ],
      [
        'unsupported +1',
        { phoneNumber: '+1 202 555 0143' },
        VALIDATION_MESSAGES.PHONE_NUMBER_INVALID,
      ],
      [
        'over 16 chars',
        { phoneNumber: '0241234567890123456' },
        VALIDATION_MESSAGES.PHONE_NUMBER_MAX_LENGTH,
      ],
    ])('400 for %s', async (_label, override, expected) => {
      const body = registerBody(override);
      const res = await register(body);
      expect(res.status).toBe(400);
      expect(messages(res)).toContain(expected);
      expect(await userRepo.count({ where: { email: body.email } })).toBe(0);
    });

    it('a duplicate number typed in another form → 409 PHONE_NUMBER_IN_USE with the documented envelope, nothing created', async () => {
      const e164 = gh();
      const first = registerBody({ phoneNumber: e164 });
      expect((await register(first)).status).toBe(201);
      for (const form of [asNational, asInternational, as00]) {
        const dup = registerBody({ phoneNumber: form(e164) });
        const res = await register(dup);
        expect(res.status).toBe(409);
        const b = res.body as Body;
        expect(b.status).toBe('error');
        expect(b.message).toBe('Phone number already in use');
        expect(b.meta).toEqual({
          timestamp: expect.any(String) as string,
          path: '/api/v1/auth/register',
          statusCode: 409,
          error: 'PHONE_NUMBER_IN_USE',
        });
        expect(await userRepo.count({ where: { email: dup.email } })).toBe(0);
      }
    });

    it('duplicate email → 409 that does not echo the address', async () => {
      const body = registerBody();
      expect((await register(body)).status).toBe(201);
      const res = await register(registerBody({ email: body.email }));
      expect(res.status).toBe(409);
      expect((res.body as Body).meta?.error).toBe('UserAlreadyExists');
      expect(JSON.stringify(res.body)).not.toContain(body.email);
    });
  });

  // ─── PATCH /users/me and admin POST /users ───────────────────────────────

  describe('PATCH /users/me and admin POST /users — PH7/PH9, DI5', () => {
    it('PATCH /users/me: national/00 input stored as E.164; invalid and OTHER rejected; omitted phone untouched', async () => {
      const { user, token } = await makeUser('me-a', Role.CUSTOMER);
      const patch = (body: Record<string, unknown>) =>
        request(server())
          .patch('/api/v1/users/me')
          .set('Authorization', `Bearer ${token}`)
          .send(body);

      const e164 = gh();
      expect((await patch({ phoneNumber: asNational(e164) })).status).toBe(200);
      expect((await userRepo.findOneBy({ id: user.id }))!.phoneNumber).toBe(
        e164,
      );

      const e2 = gh();
      expect((await patch({ phoneNumber: as00(e2) })).status).toBe(200);
      expect((await userRepo.findOneBy({ id: user.id }))!.phoneNumber).toBe(e2);

      for (const bad of ['123-456-7890', '+44 7911 123456', '0251234567']) {
        const r = await patch({ phoneNumber: bad });
        expect({ bad, status: r.status }).toEqual({ bad, status: 400 });
        expect(messages(r)).toContain(VALIDATION_MESSAGES.PHONE_NUMBER_INVALID);
      }
      const other = await patch({ gender: 'OTHER' });
      expect(other.status).toBe(400);
      expect(messages(other)).toContain(VALIDATION_MESSAGES.GENDER_INVALID);

      expect((await patch({ firstname: 'Kwesi' })).status).toBe(200);
      const after = await userRepo.findOneBy({ id: user.id });
      expect(after!.phoneNumber).toBe(e2);
      expect(after!.firstname).toBe('Kwesi');
    });

    it('PATCH /users/me: another user’s number in national form → 409 PHONE_NUMBER_IN_USE', async () => {
      const taken = gh();
      await makeUser('me-owner', Role.CUSTOMER, { phoneNumber: taken });
      const { user, token } = await makeUser('me-b', Role.CUSTOMER);
      const r = await request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ phoneNumber: asNational(taken) });
      expect(r.status).toBe(409);
      expect((r.body as Body).meta?.error).toBe('PHONE_NUMBER_IN_USE');
      expect(
        (await userRepo.findOneBy({ id: user.id }))!.phoneNumber,
      ).toBeNull();
    });

    it('an existing OTHER gender row still reads back on GET /users/me', async () => {
      const { token } = await makeUser('me-other', Role.CUSTOMER, {
        gender: Gender.OTHER,
      });
      const r = await request(server())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`);
      expect(r.status).toBe(200);
      expect((r.body as { data: { gender: string } }).data.gender).toBe(
        'OTHER',
      );
    });

    it('admin POST /users: national phone stored as E.164; OTHER and unsupported numbers rejected', async () => {
      const { token } = await makeUser('admin', Role.ADMIN);
      const create = (body: Record<string, unknown>) =>
        request(server())
          .post('/api/v1/users')
          .set('Authorization', `Bearer ${token}`)
          .send(body);
      const base = () => {
        seq += 1;
        return {
          email: email(`adm${seq}`),
          password: PASSWORD,
          username: `${TAG}a${seq}`,
          firstname: 'Ama',
          lastname: 'Sample',
          role: Role.CUSTOMER,
        };
      };
      const e164 = gh();
      const ok = base();
      const r = await create({ ...ok, phoneNumber: asNational(e164) });
      expect(r.status).toBe(201);
      expect(
        (await userRepo.findOne({ where: { email: ok.email } }))!.phoneNumber,
      ).toBe(e164);

      const other = base();
      const ro = await create({ ...other, gender: 'OTHER' });
      expect(ro.status).toBe(400);
      expect(messages(ro)).toContain(VALIDATION_MESSAGES.GENDER_INVALID);

      const uk = base();
      const ru = await create({ ...uk, phoneNumber: '+44 7911 123456' });
      expect(ru.status).toBe(400);
      expect(messages(ru)).toContain(VALIDATION_MESSAGES.PHONE_NUMBER_INVALID);
      expect(
        await userRepo.count({ where: { email: In([other.email, uk.email]) } }),
      ).toBe(0);
    });
  });

  // ─── Bio optional (B2/B5) ───────────────────────────────────────────────

  describe('artisan without a bio — B2/B5', () => {
    it('rate + location + services and no bio → complete, no bio in missingFields, listed by GET /artisans', async () => {
      const body = registerBody({ role: Role.ARTISAN });
      expect((await register(body)).status).toBe(201);
      const user = await userRepo.findOne({ where: { email: body.email } });
      await userRepo.update(user!.id, { accountVerified: true });
      const token = (await tokenService.createJWTTokens(user!)).access_token;

      const before = await request(server())
        .get('/api/v1/users/me/artisan-profile')
        .set('Authorization', `Bearer ${token}`);
      expect(before.status).toBe(200);
      const beforeData = (
        before.body as {
          data: { missingFields: string[]; isProfileComplete: boolean };
        }
      ).data;
      expect(beforeData.isProfileComplete).toBe(false);
      expect(beforeData.missingFields).not.toContain('bio');
      for (const f of beforeData.missingFields) {
        expect(['hourlyRate', 'location', 'services']).toContain(f);
      }

      const patched = await request(server())
        .patch('/api/v1/users/me/artisan-profile')
        .set('Authorization', `Bearer ${token}`)
        .send({
          hourlyRate: 40,
          location: 'Sampletown, Greater Accra',
          serviceIds: [service.id],
        });
      expect(patched.status).toBe(200);
      const data = (
        patched.body as {
          data: {
            id: number;
            bio: string | null;
            missingFields: string[];
            isProfileComplete: boolean;
          };
        }
      ).data;
      // Empty either way: `createUser` seeds `''` on this path, the social
      // path stores null (B1). Both read as "no bio".
      expect(data.bio || null).toBeNull();
      expect(data.missingFields).toEqual([]);
      expect(data.isProfileComplete).toBe(true);

      const search = await request(server())
        .get('/api/v1/artisans')
        .query({ serviceId: service.id });
      expect(search.status).toBe(200);
      const ids = (search.body as { data: Array<{ id: number }> }).data.map(
        (a) => a.id,
      );
      expect(ids).toContain(data.id);
    });
  });

  // ─── GET /locations/suggestions ─────────────────────────────────────────

  describe('GET /locations/suggestions — LOC10, LOC8, R17, PR1, PR2, PR5', () => {
    beforeEach(() => {
      photon.mode = 'ok';
      photon.calls = [];
      resetLocationState();
    });

    it('returns the documented shape, filtered (R17), mapped and capped at 8; Cache-Control private 24 h', async () => {
      const res = await suggest({ q: 'legon', country: 'gh' });
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('private, max-age=86400');
      const b = res.body as SuggestionsBody;
      expect(b.status).toBe('success');
      expect(b.message).toBe('Location suggestions retrieved');
      expect(b.meta?.statusCode).toBe(200);
      expect(Object.keys(b.data).sort()).toEqual(['available', 'suggestions']);
      expect(b.data.available).toBe(true);
      expect(b.data.suggestions).toEqual([
        {
          name: 'East Legon',
          region: 'Greater Accra',
          city: 'Accra',
          countryCode: 'GH',
        },
        {
          name: 'Legon',
          region: 'Greater Accra',
          city: 'Accra',
          countryCode: 'GH',
        },
        {
          name: 'Nhyiaeso',
          region: 'Ashanti',
          city: 'Kumasi',
          countryCode: 'GH',
        },
        { name: 'Kumasi', region: 'Ashanti', countryCode: 'GH' },
        { name: 'Tema', region: 'Greater Accra', countryCode: 'GH' },
        {
          name: 'Sample Residential Area',
          region: 'Greater Accra',
          countryCode: 'GH',
        },
        { name: 'Madina A', region: 'Volta', countryCode: 'GH' },
        { name: 'Madina B', region: 'Volta', countryCode: 'GH' },
      ]);
      expect(photon.calls).toHaveLength(1);
    });

    it('PR1/PR2: the upstream request carries only q, countrycode and the fixed params, with the JinVa User-Agent and no client headers', async () => {
      const res = await suggest({ q: '  Sample   Town  ', country: 'GH' })
        .set('Cookie', 'jinva_session=secret-session; other=1')
        .set('Authorization', 'Bearer not-a-real-token')
        .set('X-Forwarded-For', '203.0.113.7')
        .set('Forwarded', 'for=203.0.113.7')
        .set('X-Real-IP', '203.0.113.7')
        .set('Referer', 'https://app.example.com/auth/complete-signup')
        .set('Origin', 'https://app.example.com')
        .set('User-Agent', 'Mozilla/5.0 kojo.demo@example.com');
      expect(res.status).toBe(200);
      expect(photon.calls).toHaveLength(1);
      const call = photon.calls[0];
      expect(call.method).toBe('GET');
      expect(call.path).toBe('/api/');
      expect(call.params).toEqual([
        ['q', 'sample town'],
        ['countrycode', 'GH'],
        ['layer', 'city'],
        ['layer', 'district'],
        ['layer', 'locality'],
        ['limit', '8'],
        ['lang', 'en'],
      ]);
      expect(PHOTON_USER_AGENT).toMatch(/^JinVa\/\d+\.\d+\.\d+$/);
      expect(call.headers['user-agent']).toBe(PHOTON_USER_AGENT);
      expect(call.headers.accept).toBe('application/json');
      const allowed = [
        'host',
        'user-agent',
        'accept',
        'accept-encoding',
        'connection',
      ];
      expect(
        Object.keys(call.headers).filter((h) => !allowed.includes(h)),
      ).toEqual([]);
      const raw = JSON.stringify(call);
      for (const leak of [
        '203.0.113.7',
        'secret-session',
        'not-a-real-token',
        'example.com',
        'Mozilla',
      ]) {
        expect(raw).not.toContain(leak);
      }
    });

    it('serves a repeat query (any case/spacing) from the cache; another country is a separate entry', async () => {
      expect((await suggest({ q: 'cachetown', country: 'GH' })).status).toBe(
        200,
      );
      expect(photon.calls).toHaveLength(1);
      for (const q of ['CacheTown', '  cachetown ', 'CACHETOWN']) {
        const r = await suggest({ q, country: 'gh' });
        expect(r.status).toBe(200);
        expect((r.body as SuggestionsBody).data.available).toBe(true);
      }
      expect(photon.calls).toHaveLength(1);
      await suggest({ q: 'cachetown', country: 'TG' });
      expect(photon.calls).toHaveLength(2);
      expect(photon.calls[1].params).toContainEqual(['countrycode', 'TG']);
    });

    it.each([
      ['1 character', { q: 'a', country: 'GH' }],
      ['1 character after trimming', { q: '  a  ', country: 'GH' }],
      ['101 characters', { q: 'x'.repeat(101), country: 'GH' }],
      ['missing q', { country: 'GH' }],
      ['unsupported country', { q: 'legon', country: 'US' }],
      ['missing country', { q: 'legon' }],
      ['an extra parameter', { q: 'legon', country: 'GH', email: 'x' }],
    ])(
      '400 for %s, no upstream call, no query string in meta.path',
      async (_l, query) => {
        const res = await suggest(query as Record<string, string>);
        expect(res.status).toBe(400);
        expect(res.headers['cache-control']).toBe('no-store');
        const b = res.body as Body;
        expect(b.status).toBe('error');
        expect(b.meta?.path).toBe('/api/v1/locations/suggestions');
        expect(b.meta?.error).toBe('BadRequestException');
        expect(photon.calls).toHaveLength(0);
      },
    );

    it.each([
      ['a 5xx', 'error500'],
      ['a 429', 'rate429'],
      ['an unexpected payload', 'badPayload'],
      ['a timeout (> 1.5 s)', 'slow'],
    ])(
      'LOC8: %s upstream → 200, available:false, no-store; then a cooldown; failures are not cached',
      async (_l, mode) => {
        photon.mode = mode as PhotonMode;
        const started = Date.now();
        const res = await suggest({ q: `fail ${mode}`, country: 'GH' });
        const took = Date.now() - started;
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect((res.body as SuggestionsBody).message).toBe(
          'Location suggestions unavailable',
        );
        expect((res.body as SuggestionsBody).data).toEqual({
          suggestions: [],
          available: false,
        });
        expect(took).toBeLessThan(2_400);
        expect(photon.calls).toHaveLength(1);

        // Cooldown: the next lookup doesn't call upstream at all.
        photon.mode = 'ok';
        const cooled = await suggest({ q: 'another place', country: 'GH' });
        expect((cooled.body as SuggestionsBody).data.available).toBe(false);
        expect(photon.calls).toHaveLength(1);

        // After the cooldown, the failed query is fetched again (not cached).
        resetLocationState();
        const again = await suggest({ q: `fail ${mode}`, country: 'GH' });
        expect((again.body as SuggestionsBody).data.available).toBe(true);
        expect(photon.calls).toHaveLength(2);
      },
    );

    it('LOC8: an unreachable upstream (connection refused) degrades the same way', async () => {
      const svc = locationsService as unknown as { endpoint: string };
      const saved = svc.endpoint;
      svc.endpoint = 'http://127.0.0.1:9/api/';
      try {
        const res = await suggest({ q: 'refused town', country: 'GH' });
        expect(res.status).toBe(200);
        expect((res.body as SuggestionsBody).data).toEqual({
          suggestions: [],
          available: false,
        });
      } finally {
        svc.endpoint = saved;
      }
    });

    it('PR5: the typed text never appears in any log line, on success, 400, upstream failure or 429', async () => {
      const probe = 'zqxprivacyprobe';
      logged.length = 0;
      await suggest({ q: `${probe} ok`, country: 'GH' });
      await suggest({ q: `${probe} bad`, country: 'US' });
      photon.mode = 'error500';
      await suggest({ q: `${probe} fail`, country: 'GH' });
      expect(logged.length).toBeGreaterThan(0); // the capture works
      expect(logged.filter((l) => l.includes(probe))).toEqual([]);
      expect(logged.filter((l) => l.includes('203.0.113'))).toEqual([]);
    });

    it('per-IP throttle → 429 with the documented envelope and headers; nothing sent upstream for the throttled call', async () => {
      // A second, DB-free app holding only LocationsModule, with a limit of 3,
      // so the main app's raised limit is unaffected.
      process.env.LOCATION_SUGGESTIONS_RATE_LIMIT_PER_MINUTE = '3';
      const mini = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
          LocationsModule,
        ],
      }).compile();
      const miniApp: INestApplication<App> = mini.createNestApplication();
      miniApp.useGlobalInterceptors(new ResponseInterceptor());
      miniApp.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      miniApp.setGlobalPrefix('api/v1');
      await miniApp.init();
      process.env.LOCATION_SUGGESTIONS_RATE_LIMIT_PER_MINUTE = '10000';
      try {
        const hit = (q: string) =>
          request(miniApp.getHttpServer())
            .get('/api/v1/locations/suggestions')
            .query({ q, country: 'GH' });
        for (const q of ['one', 'two', 'three']) {
          expect((await hit(q)).status).toBe(200);
        }
        const calls = photon.calls.length;
        const limited = await hit('four');
        expect(limited.status).toBe(429);
        const b = limited.body as Body;
        expect(b.status).toBe('error');
        expect(b.message).toBe(
          'Too many place lookups. Keep typing, or try again shortly.',
        );
        expect(b.meta?.error).toBe('LOCATION_SUGGESTIONS_RATE_LIMITED');
        expect(b.meta?.statusCode).toBe(429);
        expect(b.meta?.path).toBe('/api/v1/locations/suggestions');
        expect(b.meta?.retryAfterSeconds).toEqual(expect.any(Number));
        expect(
          limited.headers['retry-after-location-suggestions'],
        ).toBeDefined();
        expect(limited.headers['cache-control']).toBe('no-store');
        expect(photon.calls.length).toBe(calls);
      } finally {
        await miniApp.close();
      }
    });
  });

  // ─── PH10 migration, inside a rolled-back transaction ────────────────────

  describe('PH10 migration (always rolled back)', () => {
    it('has been applied, and the dev data is already in its post-migration state', async () => {
      const applied: unknown[] = await dataSource.query(
        `SELECT name FROM "migrations" WHERE name = $1`,
        ['NormalizePhoneNumbersToE1641783230000000'],
      );
      expect(applied).toHaveLength(1);
    });

    it('down → up round-trips every row exactly; collisions abort; unparseable rows are left alone and reported by id', async () => {
      const migration = new NormalizePhoneNumbersToE1641783230000000();
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      const qr = dataSource.createQueryRunner();
      await qr.connect();
      const snapshot = async () =>
        new Map(
          (
            (await qr.query(
              `SELECT id, phone_number FROM users WHERE phone_number IS NOT NULL ORDER BY id`,
            )) as Array<{ id: number; phone_number: string }>
          ).map((r) => [r.id, r.phone_number]),
        );
      const before = await snapshot();
      // Counts for the PH10 DoD, over pre-existing rows only (not this file's).
      const [summary] = (await qr.query(
        `SELECT count(*)::int AS "withPhone",
                count(*) FILTER (WHERE phone_number ~ '^\\+[1-9][0-9]{6,14}$')::int AS "e164"
           FROM users
          WHERE phone_number IS NOT NULL AND email NOT LIKE $1`,
        [`${TAG}-%`],
      )) as Array<{ withPhone: number; e164: number }>;
      try {
        await qr.startTransaction();

        // 1. Round trip: down() then up() gives back exactly the same data.
        await migration.down(qr);
        await migration.up(qr);
        const roundTrip = await snapshot();
        let mismatches = 0;
        for (const [id, v] of before)
          if (roundTrip.get(id) !== v) mismatches += 1;
        expect(mismatches).toBe(0);
        expect(roundTrip.size).toBe(before.size);
        // Re-running up() on migrated data is a no-op (idempotent).
        await migration.up(qr);
        const upAgainLog = String(log.mock.calls.at(-1)?.[0] ?? '');
        expect(upAgainLog).toMatch(/: 0 converted to E\.164/);
        expect(upAgainLog).not.toMatch(/\+\d{6,}/); // no number in the log

        // 2. Collision + unparseable, on this file's own users only.
        const n = gh();
        const a = await makeUserInTx(qr, 'mig-a', '0' + nsn(n));
        const b = await makeUserInTx(qr, 'mig-b', asInternational(n));
        const c = await makeUserInTx(qr, 'mig-c', 'not-a-phone');
        await qr.query('SAVEPOINT before_collision');
        await expect(migration.up(qr)).rejects.toThrow(
          new RegExp(`user ids ${a}, ${b}|user ids ${b}, ${a}`),
        );
        await qr.query('ROLLBACK TO SAVEPOINT before_collision');

        // Resolve the collision; now up() converts a and leaves c unchanged.
        await qr.query(`UPDATE users SET phone_number = NULL WHERE id = $1`, [
          b,
        ]);
        await migration.up(qr);
        const line = String(log.mock.calls.at(-1)?.[0] ?? '');
        expect(line).toMatch(/: 1 converted to E\.164/);
        expect(line).toContain(String(c));
        expect(line).not.toContain('not-a-phone');
        expect(line).not.toMatch(/\+\d{6,}|0\d{9}/);
        const rows = (await qr.query(
          `SELECT id, phone_number FROM users WHERE id = ANY($1) ORDER BY id`,
          [[a, c]],
        )) as Array<{ id: number; phone_number: string }>;
        expect(rows.find((r) => r.id === a)!.phone_number).toBe(n);
        expect(rows.find((r) => r.id === c)!.phone_number).toBe('not-a-phone');
      } finally {
        if (qr.isTransactionActive) await qr.rollbackTransaction();
        await qr.release();
        log.mockRestore();
      }
      // Rolled back: the dev data is exactly as it was.
      const qr2 = dataSource.createQueryRunner();
      await qr2.connect();
      try {
        const after = new Map(
          (
            (await qr2.query(
              `SELECT id, phone_number FROM users WHERE phone_number IS NOT NULL`,
            )) as Array<{ id: number; phone_number: string }>
          ).map((r) => [r.id, r.phone_number]),
        );
        let changed = 0;
        for (const [id, v] of before) if (after.get(id) !== v) changed += 1;
        expect(changed).toBe(0);
        expect(
          await userRepo.count({ where: { email: Like(`${TAG}-mig-%`) } }),
        ).toBe(0);
      } finally {
        await qr2.release();
      }
      // Counts only (PH10 DoD) — no numbers, no ids beyond this file's own.
      process.stdout.write(
        `\n[PH10 dry run] users with a phone: ${summary.withPhone}, already E.164: ${summary.e164}, not E.164 (left unchanged as unparseable): ${summary.withPhone - summary.e164}\n`,
      );
    });

    async function makeUserInTx(
      qr: ReturnType<DataSource['createQueryRunner']>,
      label: string,
      phoneNumber: string,
    ): Promise<number> {
      const repo = qr.manager.getRepository(User);
      const u = await repo.save(
        repo.create({
          email: email(label),
          password: await bcrypt.hash(PASSWORD, 4),
          firstname: 'Mig',
          lastname: 'Probe',
          role: Role.CUSTOMER,
          accountVerified: true,
          isBanned: false,
          isSuspended: false,
          isSocialLogin: false,
          phoneNumber,
        } as Partial<User>),
      );
      return u.id;
    }
  });
});
