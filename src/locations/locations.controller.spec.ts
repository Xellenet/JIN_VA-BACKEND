import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { of, throwError } from 'rxjs';
import type { Logger as WinstonLogger } from 'winston';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { LocationsModule } from './locations.module';

/**
 * LOC10 over HTTP, wired like `src/main.ts` (global prefix, ValidationPipe,
 * ResponseInterceptor, AllExceptionsFilter).
 *
 * PR4: `HttpService` is overridden with a mock, so no request leaves the test
 * process; `ignoreEnvFile` keeps the real `.env` out of it. Place text is
 * made up.
 */
describe('GET /api/v1/locations/suggestions', () => {
  const RATE_LIMIT = 4;
  let app: INestApplication<App>;
  let httpGet: jest.Mock;
  let globalLoggerError: jest.Mock;
  let nestLogs: jest.SpyInstance[];
  const previousEnv = {
    limit: process.env.LOCATION_SUGGESTIONS_RATE_LIMIT_PER_MINUTE,
    base: process.env.PHOTON_BASE_URL,
  };

  const server = () => app.getHttpServer();
  interface Envelope {
    status: string;
    message: string | string[];
    data?: unknown;
    meta: { path: string; error?: string; retryAfterSeconds?: number };
  }
  const bodyOf = (res: request.Response) => res.body as Envelope;
  // A distinct client per test so throttle buckets don't bleed between tests.
  let clientCounter = 0;
  const nextClientIp = () => `203.0.113.${++clientCounter}`;

  beforeAll(async () => {
    process.env.LOCATION_SUGGESTIONS_RATE_LIMIT_PER_MINUTE = String(RATE_LIMIT);
    process.env.PHOTON_BASE_URL = 'http://photon.invalid';

    httpGet = jest.fn();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        LocationsModule,
      ],
    })
      .overrideProvider(HttpService)
      .useValue({ get: httpGet })
      .compile();

    app = moduleRef.createNestApplication();
    // Let the throttler see the X-Forwarded-For test IPs as distinct clients.
    (
      app.getHttpAdapter().getInstance() as {
        set: (k: string, v: unknown) => void;
      }
    ).set('trust proxy', 1);
    globalLoggerError = jest.fn();
    app.useGlobalFilters(
      new AllExceptionsFilter({
        error: globalLoggerError,
      } as unknown as WinstonLogger),
    );
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
  });

  afterAll(async () => {
    await app.close();
    process.env.LOCATION_SUGGESTIONS_RATE_LIMIT_PER_MINUTE = previousEnv.limit;
    process.env.PHOTON_BASE_URL = previousEnv.base;
    if (previousEnv.limit === undefined)
      delete process.env.LOCATION_SUGGESTIONS_RATE_LIMIT_PER_MINUTE;
    if (previousEnv.base === undefined) delete process.env.PHOTON_BASE_URL;
  });

  beforeEach(() => {
    httpGet.mockReset();
    httpGet.mockReturnValue(
      of({
        data: {
          features: [
            {
              properties: {
                osm_key: 'place',
                osm_value: 'suburb',
                name: 'East Legon',
                city: 'Accra',
                state: 'Greater Accra Region',
                countrycode: 'GH',
              },
            },
          ],
        },
      }),
    );
    globalLoggerError.mockReset();
    nestLogs = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });

  afterEach(() => {
    nestLogs.forEach((spy) => spy.mockRestore());
  });

  const allLogged = () =>
    JSON.stringify([
      globalLoggerError.mock.calls as unknown[],
      nestLogs.map((spy) => spy.mock.calls as unknown[]),
    ]);

  it('returns suggestions in the standard envelope, with a 24 h browser cache header', async () => {
    const res = await request(server())
      .get('/api/v1/locations/suggestions')
      .query({ q: 'legon', country: 'GH' })
      .set('X-Forwarded-For', nextClientIp())
      .expect(200);

    expect(res.body).toMatchObject({
      status: 'success',
      message: 'Location suggestions retrieved',
      data: {
        available: true,
        suggestions: [
          {
            name: 'East Legon',
            city: 'Accra',
            region: 'Greater Accra',
            countryCode: 'GH',
          },
        ],
      },
    });
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
  });

  it('does not forward client headers upstream (PR1)', async () => {
    await request(server())
      .get('/api/v1/locations/suggestions')
      .query({ q: 'madina', country: 'GH' })
      .set('X-Forwarded-For', nextClientIp())
      .set('Cookie', 'jinva_pending_signup=abc')
      .set('Referer', 'http://localhost:4200/complete-signup')
      .set('Authorization', 'Bearer abc')
      .expect(200);

    expect(httpGet).toHaveBeenCalledTimes(1);
    const [url, options] = httpGet.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(Object.keys(options.headers).sort()).toEqual([
      'Accept',
      'User-Agent',
    ]);
    expect(url).not.toMatch(/203\.0\.113|abc|complete-signup/);
  });

  it('serves a repeat query from the cache', async () => {
    const ip = nextClientIp();
    for (const q of ['Spintex', ' spintex ']) {
      await request(server())
        .get('/api/v1/locations/suggestions')
        .query({ q, country: 'GH' })
        .set('X-Forwarded-For', ip)
        .expect(200);
    }
    expect(httpGet).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a 1-character q', { q: 'a', country: 'GH' }],
    ['an unsupported country', { q: 'legon', country: 'US' }],
    ['a missing country', { q: 'legon' }],
    [
      'an unknown parameter',
      { q: 'legon', country: 'GH', email: 'someone@example.com' },
    ],
  ])('returns 400 for %s, without logging the query', async (_label, query) => {
    const res = await request(server())
      .get('/api/v1/locations/suggestions')
      .query(query)
      .set('X-Forwarded-For', nextClientIp())
      .expect(400);

    expect(bodyOf(res).status).toBe('error');
    expect(bodyOf(res).meta.path).toBe('/api/v1/locations/suggestions');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(httpGet).not.toHaveBeenCalled();
    expect(allLogged()).not.toMatch(/legon|q=|example\.com/);
  });

  it('returns 200 with available:false when upstream is down (LOC8)', async () => {
    // An rxjs error, as HttpService would emit for a 503.
    httpGet.mockReturnValue(
      throwError(() => ({
        isAxiosError: true,
        response: { status: 503, headers: {} },
      })),
    );

    const res = await request(server())
      .get('/api/v1/locations/suggestions')
      .query({ q: 'nkawkaw', country: 'GH' })
      .set('X-Forwarded-For', nextClientIp())
      .expect(200);

    expect(bodyOf(res).data).toEqual({ suggestions: [], available: false });
    expect(bodyOf(res).message).toBe('Location suggestions unavailable');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(allLogged()).not.toContain('nkawkaw');
  });

  it('throttles per IP at the configured rate, with a machine-readable code', async () => {
    const ip = nextClientIp();
    for (let i = 0; i < RATE_LIMIT; i += 1) {
      await request(server())
        .get('/api/v1/locations/suggestions')
        .query({ q: `tema${i}`, country: 'GH' })
        .set('X-Forwarded-For', ip)
        .expect(200);
    }

    const res = await request(server())
      .get('/api/v1/locations/suggestions')
      .query({ q: 'tema-throttled', country: 'GH' })
      .set('X-Forwarded-For', ip)
      .expect(429);

    expect(bodyOf(res).meta.error).toBe('LOCATION_SUGGESTIONS_RATE_LIMITED');
    expect(bodyOf(res).meta.retryAfterSeconds).toBeGreaterThan(0);
    expect(bodyOf(res).meta.path).toBe('/api/v1/locations/suggestions');
    expect(allLogged()).not.toMatch(/tema-throttled|203\.0\.113/);

    // Another client is unaffected.
    await request(server())
      .get('/api/v1/locations/suggestions')
      .query({ q: 'tema', country: 'GH' })
      .set('X-Forwarded-For', nextClientIp())
      .expect(200);
  });
});
