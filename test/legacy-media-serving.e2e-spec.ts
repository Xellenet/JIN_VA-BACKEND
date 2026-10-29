import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { Repository } from 'typeorm';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { applyLegacyMediaServing } from '../src/uploads/legacy-media.config';
import { Role } from '@common/types/enums';
import { User } from '@users/entities/user.entity';
import { UserTokenService } from '@users/token.service';

/**
 * BI2 regression guard — "existing media must keep resolving after the storage
 * cutover", which the requirements doc calls a blocker — plus the KYC-media
 * access boundary added on top of it: `documents`/`selfies` must NOT be
 * reachable through the public static mount in any mode, and must be readable
 * only by an authenticated admin through `GET /api/v1/uploads/kyc/...`.
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
/** A pre-cutover KYC object, in the folder that must never be public. */
const KYC_FILENAME = 'e2e0b12a-0000-4000-8000-legacykyc001.png';
const KYC_FOLDER = 'documents';
const KYC_STORED_REFERENCE = `/uploads/${KYC_FOLDER}/${KYC_FILENAME}`;
const KYC_ACCESS_URL = `/api/v1/uploads/kyc/${KYC_FOLDER}/${KYC_FILENAME}`;
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
  const kycDir = join(process.cwd(), 'uploads', KYC_FOLDER);
  const kycPath = join(kycDir, KYC_FILENAME);

  beforeAll(async () => {
    await mkdir(legacyDir, { recursive: true });
    await writeFile(legacyPath, PNG_BYTES);
    await mkdir(kycDir, { recursive: true });
    await writeFile(kycPath, PNG_BYTES);
  });

  afterAll(async () => {
    await rm(legacyPath, { force: true });
    await rm(kycPath, { force: true });
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

    /**
     * The behaviour `dotfiles: 'ignore'` is entirely about, asserted rather
     * than reasoned about in a comment: a dotfile request must land on Nest's
     * clean JSON 404, never on Express's `finalhandler` HTML stack trace and
     * never on a 403 that would confirm the path exists.
     */
    it('answers a dotfile request with a clean JSON 404, not a 403 and not an HTML stack trace', async () => {
      const dotfileDir = join(process.cwd(), 'uploads', LEGACY_FOLDER);
      const dotfilePath = join(dotfileDir, '.e2e-dotfile-probe');
      await writeFile(dotfilePath, PNG_BYTES);

      try {
        for (const path of [
          `/uploads/${LEGACY_FOLDER}/.e2e-dotfile-probe`,
          `/uploads/${LEGACY_FOLDER}/.env`,
          '/uploads/.env',
          '/uploads/.git/config',
        ]) {
          const res = await request(app.getHttpServer()).get(path);

          expect(res.status).toBe(404);
          expect(res.headers['content-type']).toContain('application/json');
          expect(res.text).not.toContain('<pre>');
          expect(res.text).not.toContain('at SendStream');
          expect(res.text).not.toContain(process.cwd());
          // A dotfile that genuinely exists on disk must not be served, and
          // must be indistinguishable from one that does not.
          expect(res.body).not.toEqual(PNG_BYTES);
        }
      } finally {
        await rm(dotfilePath, { force: true });
      }
    });

    it('does NOT serve KYC documents or selfies from the public mount, even though the file exists on disk', async () => {
      for (const path of [
        KYC_STORED_REFERENCE,
        '/uploads/documents/',
        '/uploads/selfies/',
        `/uploads/selfies/${KYC_FILENAME}`,
      ]) {
        const res = await request(app.getHttpServer()).get(path);

        expect(res.status).toBe(404);
        expect(res.headers['content-type']).toContain('application/json');
        // No year-long public caching header can be attached to a response
        // that was never produced by the static mount.
        expect(res.headers['cache-control'] ?? '').not.toContain('immutable');
        // The 404 body echoes the caller's own path (Nest's standard
        // "Cannot GET …"), which discloses nothing; what must never come back
        // is the file itself.
        expect(res.text).not.toContain('PNG');
        expect(res.headers['content-type']).not.toContain('image/');
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

  /**
   * The authenticated replacement for the public KYC URLs. A pre-cutover
   * document is written to local disk in `beforeAll` above, so this exercises
   * exactly the row shape the existing verification backlog holds.
   */
  describe('GET /api/v1/uploads/kyc/:folder/:filename — the only KYC reader', () => {
    let app: NestExpressApplication;
    let module: TestingModule;
    let userRepo: Repository<User>;
    const created: number[] = [];
    let adminToken: string;
    let artisanToken: string;
    const uniq = Date.now();

    beforeAll(async () => {
      ({ app, module } = await buildApp({ STORAGE_PROVIDER: 'local' }));

      userRepo = module.get(getRepositoryToken(User));
      const tokenService = module.get(UserTokenService);

      const admin = await userRepo.save(
        userRepo.create({
          email: `e2e-kyc-admin-${uniq}@test.jinva.local`,
          password: null,
          firstname: 'E2eKyc',
          lastname: 'Admin',
          role: Role.ADMIN,
          accountVerified: true,
          isBanned: false,
        }),
      );
      created.push(admin.id);
      adminToken = (await tokenService.createJWTTokens(admin)).access_token;

      const artisan = await userRepo.save(
        userRepo.create({
          email: `e2e-kyc-artisan-${uniq}@test.jinva.local`,
          password: null,
          firstname: 'E2eKyc',
          lastname: 'Artisan',
          role: Role.ARTISAN,
          accountVerified: true,
          isBanned: false,
        }),
      );
      created.push(artisan.id);
      artisanToken = (await tokenService.createJWTTokens(artisan)).access_token;
    });

    afterAll(async () => {
      for (const id of created) {
        try {
          await userRepo.delete(id);
        } catch {
          /* ignore — leave the shared dev DB no worse than we found it */
        }
      }
      await app.close();
    });

    it('rejects an anonymous request — the exact case an <img> tag would make', async () => {
      const res = await request(app.getHttpServer()).get(KYC_ACCESS_URL);

      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('rejects an authenticated non-admin (the artisan who uploaded it included)', async () => {
      const res = await request(app.getHttpServer())
        .get(KYC_ACCESS_URL)
        .set('Authorization', `Bearer ${artisanToken}`);

      expect(res.status).toBe(403);
    });

    it('streams the bytes to an admin, with private/no-store caching', async () => {
      const res = await request(app.getHttpServer())
        .get(KYC_ACCESS_URL)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['cache-control']).not.toContain('immutable');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.from(res.body as Buffer).equals(PNG_BYTES)).toBe(true);
    });

    it('refuses a public folder, so it cannot be turned into a general file proxy', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/uploads/kyc/${LEGACY_FOLDER}/${LEGACY_FILENAME}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
    });

    it('refuses a traversal attempt in the filename', async () => {
      for (const filename of ['..%2f..%2fpackage.json', '.env', '..']) {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/uploads/kyc/documents/${filename}`)
          .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.text).not.toContain('"jinva-backend"');
      }
    });

    it('404s for a well-formed filename that does not exist', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/uploads/kyc/documents/does-not-exist.png')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
    });
  });
});
