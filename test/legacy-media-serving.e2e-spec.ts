import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { applyLegacyMediaServing } from '../src/uploads/legacy-media.config';

/**
 * BI2 regression guard — "existing media must keep resolving after the storage
 * cutover", which the requirements doc calls a blocker.
 *
 * `STORAGE_PROVIDER` is never mutated on the real process: the environment is
 * passed to `applyLegacyMediaServing` as an argument, which is exactly why
 * that function takes one. It is also the *same* function `main.ts` calls, so
 * this asserts against the shipped configuration rather than a copy of it.
 *
 * Run: npm run test:e2e -- legacy-media-serving
 */
jest.setTimeout(300000);

/** A pre-cutover-shaped object: UUID filename, real folder, relative URL. */
const LEGACY_FILENAME = 'e2e0b12a-0000-4000-8000-legacymedia01.png';
const LEGACY_FOLDER = 'avatars';
const LEGACY_URL = `/uploads/${LEGACY_FOLDER}/${LEGACY_FILENAME}`;
/** Smallest valid PNG (1x1, transparent). */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4DwABBAEAX+XKPgAAAABJRU5ErkJggg==',
  'base64',
);

const buildApp = async (
  env: Record<string, string | undefined>,
): Promise<{ app: NestExpressApplication; module: TestingModule }> => {
  const module: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = module.createNestApplication<NestExpressApplication>();
  const logger = app.get<WinstonLogger>(WINSTON_MODULE_NEST_PROVIDER);
  // Same filters as `main.ts`: the point of one assertion below is that a miss
  // reaches Nest's exception layer rather than Express's default
  // `finalhandler`, so the production filters have to be in place.
  app.useGlobalFilters(new AllExceptionsFilter(logger), new TypeOrmFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  applyLegacyMediaServing(app, { ...process.env, ...env });
  app.setGlobalPrefix('api/v1', { exclude: ['/'] });
  await app.init();

  return { app, module };
};

describe('BI2 — legacy /uploads media after the S3 cutover (e2e)', () => {
  const legacyDir = join(process.cwd(), 'uploads', LEGACY_FOLDER);
  const legacyPath = join(legacyDir, LEGACY_FILENAME);

  beforeAll(async () => {
    await mkdir(legacyDir, { recursive: true });
    await writeFile(legacyPath, PNG_BYTES);
  });

  afterAll(async () => {
    await rm(legacyPath, { force: true });
  });

  describe('with STORAGE_PROVIDER=s3 (new media goes to the bucket)', () => {
    let app: NestExpressApplication;

    beforeAll(async () => {
      ({ app } = await buildApp({ STORAGE_PROVIDER: 's3' }));
    });

    afterAll(async () => {
      await app.close();
    });

    it('still serves a row written before the cutover (the blocker guard)', async () => {
      const res = await request(app.getHttpServer()).get(LEGACY_URL);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
      expect(Buffer.from(res.body as Buffer).equals(PNG_BYTES)).toBe(true);
    });

    it('sends nosniff and long immutable caching, so a CDN/browser stops re-asking the app', async () => {
      const res = await request(app.getHttpServer()).get(LEGACY_URL);

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toContain('immutable');
      expect(res.headers['cache-control']).toContain('max-age=31536000');
    });

    it('answers a missing legacy file with a clean JSON 404, not an HTML stack trace', async () => {
      const res = await request(app.getHttpServer()).get(
        '/uploads/avatars/does-not-exist.png',
      );

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.text).not.toContain('<pre>');
      expect(res.text).not.toContain('at ServeStatic');
      expect(res.text).not.toContain(process.cwd());
    });

    it('does not expose a directory listing for an upload folder', async () => {
      const res = await request(app.getHttpServer()).get('/uploads/avatars/');

      expect(res.status).toBe(404);
      expect(res.text).not.toContain(LEGACY_FILENAME);
    });

    it('does not let a traversal attempt climb out of the uploads tree', async () => {
      for (const path of [
        '/uploads/../package.json',
        '/uploads/avatars/../../package.json',
        '/uploads/%2e%2e/package.json',
      ]) {
        const res = await request(app.getHttpServer()).get(path);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.text).not.toContain('"jinva-backend"');
      }
    });
  });

  describe('with SERVE_LEGACY_UPLOADS=false (operator has moved the legacy tree)', () => {
    let app: NestExpressApplication;

    beforeAll(async () => {
      ({ app } = await buildApp({
        STORAGE_PROVIDER: 's3',
        SERVE_LEGACY_UPLOADS: 'false',
      }));
    });

    afterAll(async () => {
      await app.close();
    });

    it('serves no media at all from the app process', async () => {
      const res = await request(app.getHttpServer()).get(LEGACY_URL);

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
    });
  });
});
