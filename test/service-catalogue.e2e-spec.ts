/**
 * The service catalogue, over real HTTP and the real (PGlite) database:
 *   - the SeedServiceCatalogue migration: the 8 service types exist after a
 *     fresh migrate, unpriced; running it again inserts nothing; it leaves
 *     existing rows alone; down() removes only unchanged, unused rows;
 *   - who may write: customers and artisans get 403, anonymous 401, admins
 *     succeed, reads stay public;
 *   - names are unique in any case (409), a service in use can't be deleted
 *     (409) and is hidden instead, and a hidden service leaves the public
 *     catalogue and takes no new jobs.
 * The migration checks run inside transactions that are rolled back, and
 * everything else this suite creates is removed afterwards.
 */
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '10000';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { DataSource, Repository } from 'typeorm';
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
import { UserTokenService } from '@users/token.service';
import { ServiceEntity } from '@services/entities/service.entity';
import { Role } from '@common/types/enums';
import {
  SERVICE_CATALOGUE,
  SeedServiceCatalogue1783350000000,
} from '../src/migrations/1783350000000-SeedServiceCatalogue';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(120000);

const NAMES = SERVICE_CATALOGUE.map((s) => s.name);

type Row = {
  id: number;
  name: string;
  description: string | null;
  price: string | null;
  estimated_duration_mins: number;
  is_active: boolean;
};
type Body = { message: string; data: Record<string, unknown> };
type ListBody = {
  data: Array<{
    id: number;
    name: string;
    isActive: boolean;
    usage?: { artisans: number; bookings: number; jobs: number };
  }>;
};

describe('Service catalogue (migration, permissions, delete and hide)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let services: Repository<ServiceEntity>;
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const serviceIds: number[] = [];
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });
  const email = (label: string) => `sc-${label}-${uniq}@test.jinva.local`;

  /** The catalogue rows, matched case-insensitively, in catalogue order. */
  const catalogueRows = async (
    q: {
      query: (sql: string, params?: unknown[]) => Promise<unknown>;
    } = dataSource,
  ): Promise<Row[]> => {
    const rows = (await q.query(
      `SELECT id, name, description, price, estimated_duration_mins, is_active
         FROM services WHERE LOWER(name) = ANY($1)`,
      [NAMES.map((n) => n.toLowerCase())],
    )) as Row[];
    return rows.sort(
      (a, b) =>
        NAMES.findIndex((n) => n.toLowerCase() === a.name.toLowerCase()) -
        NAMES.findIndex((n) => n.toLowerCase() === b.name.toLowerCase()),
    );
  };

  /** Runs `fn` in a transaction that is always rolled back. */
  const inRollback = async (
    fn: (qr: ReturnType<DataSource['createQueryRunner']>) => Promise<void>,
  ) => {
    const qr = dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await fn(qr);
    } finally {
      await qr.rollbackTransaction();
      await qr.release();
    }
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
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
    dataSource = moduleFixture.get(DataSource);
    services = moduleFixture.get(getRepositoryToken(ServiceEntity));
    const users: Repository<User> = moduleFixture.get(getRepositoryToken(User));
    const profiles: Repository<ArtisanProfile> = moduleFixture.get(
      getRepositoryToken(ArtisanProfile),
    );
    const tokens = moduleFixture.get(UserTokenService);

    const make = async (label: string, role: Role) => {
      const u = await users.save(
        users.create({
          email: email(label),
          username: `sc${label}${uniq}`,
          firstname: 'Efua',
          lastname: 'Quaye',
          role,
          accountVerified: true,
          password: null,
        }),
      );
      token[label] = (await tokens.createJWTTokens(u)).access_token;
      return u;
    };
    await make('customer', Role.CUSTOMER);
    const artisan = await make('artisan', Role.ARTISAN);
    await make('admin', Role.ADMIN);

    // A service of this suite's own, offered by its artisan, for the
    // delete-in-use and hide checks (the catalogue rows stay untouched).
    const masonry = await services.save(
      services.create({ name: `Catalogue Masonry ${uniq}` }),
    );
    serviceIds.push(masonry.id);
    await profiles.save(
      profiles.create({
        user: artisan,
        hourlyRate: 80,
        location: 'Cape Coast, Central',
        currency: 'GHS',
        isProfileComplete: true,
        services: [masonry],
      }),
    );
  });

  afterAll(async () => {
    try {
      await removeTestData(dataSource, {
        userIds: await testUserIds(dataSource, 'sc-'),
        serviceIds,
      });
    } finally {
      await app.close();
    }
  });

  describe('SeedServiceCatalogue migration', () => {
    it('leaves the 8 service types on a freshly migrated database, unpriced and visible', async () => {
      const rows = await catalogueRows();
      expect(rows.map((r) => r.name)).toEqual(NAMES);
      for (const [i, row] of rows.entries()) {
        expect(row.description).toBe(SERVICE_CATALOGUE[i].description);
        expect(row.price).toBeNull();
        expect(row.estimated_duration_mins).toBe(60);
        expect(row.is_active).toBe(true);
      }
    });

    it('inserts nothing when it runs again', async () => {
      await inRollback(async (qr) => {
        const before = await catalogueRows(qr);
        await new SeedServiceCatalogue1783350000000().up(qr);
        expect(await catalogueRows(qr)).toEqual(before);
      });
    });

    it('leaves existing rows alone, matching names in any case, and fills only the gaps', async () => {
      await inRollback(async (qr) => {
        await qr.query(
          `UPDATE services SET name = 'PLUMBING', description = 'Our own words', price = 99
            WHERE name = 'Plumbing'`,
        );
        await qr.query(`DELETE FROM services WHERE name = 'Tiling'`);

        await new SeedServiceCatalogue1783350000000().up(qr);

        const rows = await catalogueRows(qr);
        expect(rows).toHaveLength(8);
        const plumbing = rows.filter(
          (r) => r.name.toLowerCase() === 'plumbing',
        );
        expect(plumbing).toEqual([
          expect.objectContaining({
            name: 'PLUMBING',
            description: 'Our own words',
            price: '99.00',
          }),
        ]);
        expect(rows.find((r) => r.name === 'Tiling')).toMatchObject({
          description: 'Floor and wall tiling installation and repairs',
          price: null,
        });
      });
      expect(await catalogueRows()).toHaveLength(8);
    });

    it('down() removes only rows that are unchanged and unused', async () => {
      await inRollback(async (qr) => {
        const [plumbing] = await catalogueRows(qr);
        const [{ id: profileId }] = (await qr.query(
          `SELECT ap.id FROM artisan_profiles ap JOIN users u ON u.id = ap.user_id
            WHERE u.email = $1`,
          [email('artisan')],
        )) as Array<{ id: number }>;
        await qr.query(
          `INSERT INTO artisan_profile_services (artisan_profile_id, service_id) VALUES ($1, $2)`,
          [profileId, plumbing.id],
        );
        await qr.query(
          `UPDATE services SET price = 120 WHERE name = 'Electrical'`,
        );
        await qr.query(
          `UPDATE services SET description = 'Braids and cornrows' WHERE name = 'Hair Braiding'`,
        );

        await new SeedServiceCatalogue1783350000000().down(qr);

        expect((await catalogueRows(qr)).map((r) => r.name)).toEqual([
          'Plumbing', // an artisan offers it
          'Electrical', // an admin priced it
          'Hair Braiding', // an admin reworded it
        ]);
      });
      expect(await catalogueRows()).toHaveLength(8);
    });
  });

  describe('reads are public, writes are admin-only', () => {
    let createdId = 0;

    it('lists and fetches services without a token, with a null price as null', async () => {
      const list = await request(server()).get('/api/v1/services');
      expect(list.status).toBe(200);
      const names = (list.body as ListBody).data.map((s) => s.name);
      expect(names).toEqual(expect.arrayContaining(NAMES));

      const [plumbing] = await catalogueRows();
      const one = await request(server()).get(
        `/api/v1/services/${plumbing.id}`,
      );
      expect(one.status).toBe(200);
      const data = (one.body as Body).data;
      expect(Object.keys(data).sort()).toEqual([
        'createdAt',
        'description',
        'estimatedDurationMins',
        'id',
        'isActive',
        'name',
        'price',
        'updatedAt',
      ]);
      expect(data).toMatchObject({
        id: plumbing.id,
        name: 'Plumbing',
        description: 'Water supply, drainage, and piping services',
        price: null,
        estimatedDurationMins: 60,
        isActive: true,
      });
    });

    it.each(['customer', 'artisan'])(
      'refuses POST, PATCH and DELETE from a %s with 403',
      async (who) => {
        const target = serviceIds[0];
        const post = await request(server())
          .post('/api/v1/services')
          .set(as(who))
          .send({ name: `Sneaky ${who} ${uniq}` });
        const patch = await request(server())
          .patch(`/api/v1/services/${target}`)
          .set(as(who))
          .send({ price: 1 });
        const del = await request(server())
          .delete(`/api/v1/services/${target}`)
          .set(as(who));
        expect([post.status, patch.status, del.status]).toEqual([
          403, 403, 403,
        ]);
        expect(await services.findOneBy({ id: target })).toMatchObject({
          price: null,
        });
      },
    );

    it('refuses POST, PATCH and DELETE without a token with 401', async () => {
      const target = serviceIds[0];
      const statuses = [
        (
          await request(server())
            .post('/api/v1/services')
            .send({ name: `Anon ${uniq}` })
        ).status,
        (
          await request(server())
            .patch(`/api/v1/services/${target}`)
            .send({ price: 1 })
        ).status,
        (await request(server()).delete(`/api/v1/services/${target}`)).status,
      ];
      expect(statuses).toEqual([401, 401, 401]);
    });

    it('lets an admin create, edit and delete an unused service', async () => {
      const created = await request(server())
        .post('/api/v1/services')
        .set(as('admin'))
        .send({
          name: `  Roof   Repairs ${uniq} `,
          description: '  Leaks and gutters ',
          price: 250.5,
          estimatedDurationMins: 120,
        });
      expect(created.status).toBe(201);
      const data = (created.body as Body).data;
      createdId = data.id as number;
      serviceIds.push(createdId);
      expect(data).toMatchObject({
        name: `Roof Repairs ${uniq}`,
        description: 'Leaks and gutters',
        price: '250.50',
        estimatedDurationMins: 120,
        isActive: true,
      });

      const edited = await request(server())
        .patch(`/api/v1/services/${createdId}`)
        .set(as('admin'))
        .send({ price: null, description: '' });
      expect(edited.status).toBe(200);
      expect((edited.body as Body).data).toMatchObject({
        price: null,
        description: null,
      });

      const del = await request(server())
        .delete(`/api/v1/services/${createdId}`)
        .set(as('admin'));
      expect(del.status).toBe(200);
      expect(await services.findOneBy({ id: createdId })).toBeNull();
    });

    it('refuses a duplicate name in any case with a friendly 409', async () => {
      const res = await request(server())
        .post('/api/v1/services')
        .set(as('admin'))
        .send({ name: ' plumbing ' });
      expect(res.status).toBe(409);
      expect((res.body as Body).message).toBe(
        'A service called "Plumbing" already exists. Choose a different name, or edit that service instead.',
      );

      const rename = await request(server())
        .patch(`/api/v1/services/${serviceIds[0]}`)
        .set(as('admin'))
        .send({ name: 'TILING' });
      expect(rename.status).toBe(409);
    });

    it('validates names and prices', async () => {
      const bad = async (body: Record<string, unknown>) =>
        (
          await request(server())
            .post('/api/v1/services')
            .set(as('admin'))
            .send(body)
        ).status;
      expect(await bad({ name: '   ' })).toBe(400);
      expect(await bad({ name: 'x'.repeat(61) })).toBe(400);
      expect(await bad({ name: `Neg ${uniq}`, price: -1 })).toBe(400);
      expect(await bad({ name: `Dp ${uniq}`, price: 10.555 })).toBe(400);
    });
  });

  describe('a service in use is hidden, not deleted', () => {
    it('refuses to delete it with 409 and says to hide it', async () => {
      const res = await request(server())
        .delete(`/api/v1/services/${serviceIds[0]}`)
        .set(as('admin'));
      expect(res.status).toBe(409);
      expect((res.body as Body).message).toBe(
        "This service can't be deleted because 1 artisan offers it. Hide it instead, so no one new can pick it, or ask those artisans to remove it from their profile first.",
      );
      expect(await services.findOneBy({ id: serviceIds[0] })).not.toBeNull();
    });

    it('once hidden, leaves the public list, stays visible to admins with usage, and takes no new jobs', async () => {
      const id = serviceIds[0];
      const hide = await request(server())
        .patch(`/api/v1/services/${id}`)
        .set(as('admin'))
        .send({ isActive: false });
      expect(hide.status).toBe(200);
      expect((hide.body as Body).data).toMatchObject({ isActive: false });

      const ids = async (path: string, who?: string) => {
        const req = request(server()).get(path);
        if (who) void req.set(as(who));
        const res = await req;
        expect(res.status).toBe(200);
        return (res.body as ListBody).data;
      };
      expect(
        (await ids('/api/v1/services?limit=200')).map((s) => s.id),
      ).not.toContain(id);
      expect(
        (
          await ids(
            '/api/v1/services?limit=200&includeInactive=true',
            'customer',
          )
        ).map((s) => s.id),
      ).not.toContain(id);
      const adminView = await ids(
        '/api/v1/services?limit=200&includeInactive=true',
        'admin',
      );
      expect(adminView.find((s) => s.id === id)).toMatchObject({
        isActive: false,
        usage: { artisans: 1, bookings: 0, jobs: 0 },
      });

      // Still resolvable by id, for the records that keep it.
      expect(
        (await request(server()).get(`/api/v1/services/${id}`)).status,
      ).toBe(200);

      const job = await request(server())
        .post('/api/v1/jobs')
        .set(as('customer'))
        .send({
          title: 'Rebuild a garden wall',
          description: 'A low garden wall fell over in the rain last week.',
          serviceId: id,
          location: 'Cape Coast, Central',
          budgetMin: 300,
          budgetMax: 600,
          currency: 'GHS',
        });
      expect(job.status).toBe(400);
      expect((job.body as Body).message).toBe(
        'That service type is no longer offered. Choose another one.',
      );

      const show = await request(server())
        .patch(`/api/v1/services/${id}`)
        .set(as('admin'))
        .send({ isActive: true });
      expect(show.status).toBe(200);
      expect(
        (await ids('/api/v1/services?limit=200')).map((s) => s.id),
      ).toContain(id);
    });
  });
});
