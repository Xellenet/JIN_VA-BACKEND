/**
 * Customer Experience v2, B1 and B1h over real HTTP and the in-memory
 * database: `DELETE /users/me/avatar`, `profilePicture` no longer accepted on
 * `PATCH /users/me`, and the upload routes unchanged apart from their limit.
 *
 * Covers E-3.1 to E-3.7 and T-10. Storage is the local provider with its
 * `upload`/`delete` spied, so no file is written or removed on disk. Every
 * person and value here is fictional.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { DataSource, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { UserTokenService } from '@users/token.service';
import { Role } from '@common/types/enums';
import { LocalStorageProvider } from '../src/uploads/providers/local-storage.provider';
import { expectNoForbiddenFields } from './support/forbidden-fields';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(120000);

/** The response envelope, typed loosely enough for assertions. */
interface Envelope {
  status: string;
  message: unknown;
  data: Record<string, unknown>;
  meta: Record<string, unknown>;
}
const body = (res: request.Response): Envelope => res.body as Envelope;

// Generous here; the limit itself is covered in customer-throttlers.e2e-spec.
process.env.PROFILE_MEDIA_WRITE_RATE_LIMIT_PER_HOUR = '200';

const PREFIX = 'cx2pp-';

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const pad = (head: Buffer, size: number) =>
  Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
const JPEG_HEAD = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const WEBP_HEAD = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);
const GIF_HEAD = Buffer.from('GIF89a');

describe('Profile photo (B1, B1h)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let users: Repository<User>;
  let local: LocalStorageProvider;
  let deleteSpy: jest.SpyInstance;
  let uploadSpy: jest.SpyInstance;
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const ids: Record<string, number> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });

  const remove = (who?: string) => {
    const req = request(server()).delete('/api/v1/users/me/avatar');
    return who ? req.set(as(who)) : req;
  };
  const stored = async (userId: number) =>
    (
      await dataSource.query<Array<{ profile_picture: string | null }>>(
        'SELECT profile_picture FROM users WHERE id = $1',
        [userId],
      )
    )[0].profile_picture;
  const setPhoto = (userId: number, value: string | null) =>
    dataSource.query('UPDATE users SET profile_picture = $2 WHERE id = $1', [
      userId,
      value,
    ]);
  const events = (userId: number) =>
    dataSource.query<Array<{ event: string; fields_changed: string[] }>>(
      'SELECT event, fields_changed FROM account_security_events WHERE user_id = $1',
      [userId],
    );

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
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
    dataSource = moduleFixture.get(DataSource);
    users = moduleFixture.get(getRepositoryToken(User));
    local = moduleFixture.get(LocalStorageProvider);

    const profiles: Repository<ArtisanProfile> = moduleFixture.get(
      getRepositoryToken(ArtisanProfile),
    );
    const tokens = moduleFixture.get(UserTokenService);
    const make = async (
      label: string,
      role: Role,
      extra: Partial<User> = {},
    ) => {
      const u = await users.save(
        users.create({
          email: `${PREFIX}${label}-${uniq}@test.jinva.local`,
          username: `cx2pp${label}${uniq}`,
          firstname: 'Efua',
          lastname: 'Asante',
          role,
          accountVerified: true,
          ...extra,
        }),
      );
      ids[label] = u.id;
      if (role === Role.ARTISAN) {
        await profiles.save(profiles.create({ user: u, hourlyRate: 70 }));
      }
      token[label] = (await tokens.createJWTTokens(u)).access_token;
    };
    await make('a', Role.CUSTOMER);
    await make('b', Role.CUSTOMER);
    await make('g', Role.CUSTOMER);
    await make('e', Role.CUSTOMER);
    await make('n', Role.CUSTOMER);
    await make('s', Role.CUSTOMER, { isSuspended: true });
    await make('k', Role.ARTISAN);
  });

  beforeEach(() => {
    deleteSpy = jest.spyOn(local, 'delete').mockResolvedValue(undefined);
    uploadSpy = jest
      .spyOn(local, 'upload')
      .mockImplementation((_buffer, options) =>
        Promise.resolve({
          url: `/uploads/${options.folder}/cx2pp-${uniq}.png`,
          filename: `cx2pp-${uniq}.png`,
          folder: options.folder,
          sizeBytes: 1,
        }),
      );
  });
  afterEach(() => {
    deleteSpy.mockRestore();
    uploadSpy.mockRestore();
  });

  afterAll(async () => {
    await removeTestData(dataSource, {
      userIds: await testUserIds(dataSource, PREFIX),
    });
    await app.close();
  });

  it("E-3.1 / E-3.2: removes A's photo, deletes A's file once, records the event, and leaves B alone", async () => {
    await setPhoto(ids.a, '/uploads/avatars/cx2pp-a-photo.webp');
    await setPhoto(ids.b, '/uploads/avatars/cx2pp-b-photo.webp');

    const res = await remove('a');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(body(res).message).toBe('Profile photo removed');
    expect(body(res).data.id).toBe(ids.a);
    expect(body(res).data.profilePicture).toBeNull();
    // The same shape as GET /users/me.
    const me = await request(server()).get('/api/v1/users/me').set(as('a'));
    expect(body(me).data.profilePicture).toBeNull();
    expect(Object.keys(body(res).data as object).sort()).toEqual(
      Object.keys(body(me).data as object).sort(),
    );
    expectNoForbiddenFields(res.body, { allowKeys: ['email', 'phoneNumber'] });

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith('cx2pp-a-photo.webp', 'avatars');
    expect(await stored(ids.a)).toBeNull();
    expect(await stored(ids.b)).toBe('/uploads/avatars/cx2pp-b-photo.webp');
    expect(await events(ids.a)).toEqual([
      { event: 'profile_photo.removed', fields_changed: [] },
    ]);
    expect(await events(ids.b)).toEqual([]);
  });

  it('calling it again with no photo still succeeds, touches no storage and records nothing', async () => {
    const res = await remove('n');
    expect(res.status).toBe(200);
    expect(body(res).data.profilePicture).toBeNull();
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await events(ids.n)).toEqual([]);
  });

  it('E-3.3: no token gets 401', async () => {
    expect((await remove()).status).toBe(401);
  });

  it('E-3.4: an artisan may remove their own photo, and only theirs', async () => {
    await setPhoto(ids.k, '/uploads/avatars/cx2pp-k-photo.webp');
    await setPhoto(ids.b, '/uploads/avatars/cx2pp-b-photo.webp');
    const res = await remove('k');
    expect(res.status).toBe(200);
    expect(await stored(ids.k)).toBeNull();
    expect(await stored(ids.b)).toBe('/uploads/avatars/cx2pp-b-photo.webp');
  });

  it('E-3.5: a storage failure is never surfaced', async () => {
    await setPhoto(ids.e, '/uploads/avatars/cx2pp-e-photo.webp');
    deleteSpy.mockRejectedValueOnce(new Error('EACCES'));
    const res = await remove('e');
    expect(res.status).toBe(200);
    expect(await stored(ids.e)).toBeNull();
  });

  it('T-10: a Google photo, or a path outside our avatars folder, is cleared but never deleted from storage', async () => {
    for (const value of [
      'https://lh3.googleusercontent.com/a/cx2pp-photo=s96-c',
      '/uploads/avatars/../documents/cx2pp-id.png',
      '/uploads/documents/cx2pp-id.png',
      '/uploads/avatars/%2e%2e%2fselfies%2fx.png',
    ]) {
      await setPhoto(ids.g, value);
      const res = await remove('g');
      expect(res.status).toBe(200);
      expect(await stored(ids.g)).toBeNull();
    }
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  describe("SEC-5: another account pointing at A's avatar file can never delete it", () => {
    it('POST /auth/register with a profilePicture gets 400 and creates no account', async () => {
      const email = `${PREFIX}reg-${uniq}@test.jinva.local`;
      const res = await request(server())
        .post('/api/v1/auth/register')
        .send({
          email,
          password: 'Fict1onal!Passw0rd',
          username: `cx2ppreg${uniq}`,
          firstname: 'Kofi',
          lastname: 'Mensah',
          phoneNumber: '+233241230987',
          gender: 'MALE',
          role: Role.CUSTOMER,
          profilePicture: '/uploads/avatars/cx2pp-a-victim.webp',
        });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('profilePicture');
      expect(await users.findOne({ where: { email } })).toBeNull();
    });

    it("B's DELETE clears B's copy of A's path (either URL form) and A's file survives", async () => {
      const previousBase = process.env.AWS_S3_PUBLIC_URL_BASE;
      process.env.AWS_S3_PUBLIC_URL_BASE = 'https://cdn.test.jinva.local';
      try {
        for (const value of [
          '/uploads/avatars/cx2pp-a-victim.webp',
          'https://cdn.test.jinva.local/avatars/cx2pp-a-victim.webp',
        ]) {
          await setPhoto(ids.a, '/uploads/avatars/cx2pp-a-victim.webp');
          // A legacy account that set A's path as free text.
          await setPhoto(ids.b, value);

          const res = await remove('b');
          expect(res.status).toBe(200);
          expect(body(res).data.profilePicture).toBeNull();
          expect(await stored(ids.b)).toBeNull();
          expect(await stored(ids.a)).toBe(
            '/uploads/avatars/cx2pp-a-victim.webp',
          );
        }
        expect(deleteSpy).not.toHaveBeenCalled();

        // A, now the only holder, still removes and deletes their own file.
        const own = await remove('a');
        expect(own.status).toBe(200);
        expect(deleteSpy).toHaveBeenCalledTimes(1);
        expect(deleteSpy).toHaveBeenCalledWith(
          'cx2pp-a-victim.webp',
          'avatars',
        );
      } finally {
        if (previousBase === undefined) {
          delete process.env.AWS_S3_PUBLIC_URL_BASE;
        } else {
          process.env.AWS_S3_PUBLIC_URL_BASE = previousBase;
        }
      }
    });
  });

  it('a suspended account gets 403 and keeps its photo', async () => {
    await setPhoto(ids.s, '/uploads/avatars/cx2pp-s-photo.webp');
    const res = await remove('s');
    expect(res.status).toBe(403);
    expect(await stored(ids.s)).toBe('/uploads/avatars/cx2pp-s-photo.webp');
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('E-3.6 / T-10: PATCH /users/me with profilePicture gets 400 and changes nothing', async () => {
    await setPhoto(ids.b, '/uploads/avatars/cx2pp-b-photo.webp');
    const res = await request(server())
      .patch('/api/v1/users/me')
      .set(as('b'))
      .send({ profilePicture: 'https://tracker.example.com/p.gif' });
    expect(res.status).toBe(400);
    expect(await stored(ids.b)).toBe('/uploads/avatars/cx2pp-b-photo.webp');

    // Other fields still save.
    const ok = await request(server())
      .patch('/api/v1/users/me')
      .set(as('b'))
      .send({ firstname: 'Abena' });
    expect(ok.status).toBe(200);
  });

  describe('E-3.7 regression: the upload routes accept and refuse exactly as before', () => {
    const upload = (
      route: string,
      field: string,
      buffer: Buffer,
      name: string,
      type: string,
    ) =>
      request(server())
        .post(route)
        .set(as('b'))
        .attach(field, buffer, { filename: name, contentType: type });

    it.each([
      ['/api/v1/users/me/avatar', 'avatar'],
      ['/api/v1/uploads/avatar', 'file'],
    ])('%s', async (route, field) => {
      const jpeg = await upload(
        route,
        field,
        pad(JPEG_HEAD, 1024 * 1024),
        'a.jpg',
        'image/jpeg',
      );
      expect(jpeg.status).toBe(route.includes('users') ? 201 : 200);
      const png = await upload(route, field, VALID_PNG, 'a.png', 'image/png');
      expect(png.status).toBe(route.includes('users') ? 201 : 200);
      const webp = await upload(
        route,
        field,
        pad(WEBP_HEAD, 2048),
        'a.webp',
        'image/webp',
      );
      expect(webp.status).toBe(route.includes('users') ? 201 : 200);

      const gif = await upload(
        route,
        field,
        pad(GIF_HEAD, 2048),
        'a.gif',
        'image/gif',
      );
      expect(gif.status).toBe(400);
      expect(String(body(gif).message)).toBe(
        'Avatars must be JPEG, PNG, or WebP.',
      );

      const big = await upload(
        route,
        field,
        pad(JPEG_HEAD, 5 * 1024 * 1024 + 1),
        'big.jpg',
        'image/jpeg',
      );
      expect([400, 413]).toContain(big.status);
      expect(uploadSpy).toHaveBeenCalledTimes(3);
    });
  });
});
