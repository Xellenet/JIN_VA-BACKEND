/**
 * QA MSG-18, over real HTTP: message images and job photos are no longer
 * public. Only the two people in a conversation can open its image, and only
 * people who can see a job can open its photos; everyone else gets the same
 * 404 as a file that doesn't exist, and the old public path serves nothing.
 * Everything this suite creates, files on disk included, is removed afterwards.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DataSource, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import cookieParser from 'cookie-parser';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { applyLegacyMediaServing } from '../src/uploads/legacy-media.config';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { UserTokenService } from '@users/token.service';
import { ServiceEntity } from '@services/entities/service.entity';
import { Role } from '@common/types/enums';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(120000);

/** Minimal genuinely-valid 1x1 PNG (passes `file-type` magic-byte sniffing). */
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('Private message and job media (MSG-18)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let serviceId = 0;
  const uploaded: string[] = [];
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });
  const privatePath = (reference: string) =>
    reference.replace(/^\/uploads\//, '/api/v1/uploads/private/');

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.use(cookieParser());
    // The same legacy static mount main.ts applies, to prove it no longer
    // serves these folders.
    applyLegacyMediaServing(app as unknown as NestExpressApplication);
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

    const services: Repository<ServiceEntity> = moduleFixture.get(
      getRepositoryToken(ServiceEntity),
    );
    serviceId = (
      await services.save(
        services.create({
          name: `Media Tiling ${uniq}`,
          estimatedDurationMins: 60,
        }),
      )
    ).id;
    const users: Repository<User> = moduleFixture.get(getRepositoryToken(User));
    const profiles: Repository<ArtisanProfile> = moduleFixture.get(
      getRepositoryToken(ArtisanProfile),
    );
    const tokens = moduleFixture.get(UserTokenService);
    const make = async (label: string, role: Role) => {
      const u = await users.save(
        users.create({
          email: `pm-${label}-${uniq}@test.jinva.local`,
          username: `pm${label}${uniq}`,
          firstname: 'Esi',
          lastname: 'Quaye',
          role,
          accountVerified: true,
        }),
      );
      if (role === Role.ARTISAN) {
        await profiles.save(profiles.create({ user: u, hourlyRate: 60 }));
      }
      token[label] = (await tokens.createJWTTokens(u)).access_token;
      return u;
    };
    await make('sender', Role.CUSTOMER);
    await make('outsider', Role.CUSTOMER);
    await make('admin', Role.ADMIN);
    await make('artisan', Role.ARTISAN);
    userIdOf.recipient = (await make('recipient', Role.ARTISAN)).id;
  });

  const userIdOf: Record<string, number> = {};

  afterAll(async () => {
    try {
      for (const reference of uploaded.filter(Boolean)) {
        await unlink(join(process.cwd(), reference.replace(/^\//, ''))).catch(
          () => undefined,
        );
      }
      await removeTestData(dataSource, {
        userIds: await testUserIds(dataSource, 'pm-'),
        serviceIds: serviceId ? [serviceId] : [],
      });
    } finally {
      await app.close();
    }
  });

  async function upload(who: string, endpoint: string): Promise<string> {
    const res = await request(server())
      .post(`/api/v1/uploads/${endpoint}`)
      .set(as(who))
      .attach('file', VALID_PNG, {
        filename: 'photo.png',
        contentType: 'image/png',
      });
    expect(res.status).toBe(200);
    const url = (res.body as { data: { url: string } }).data.url;
    uploaded.push(url);
    return url;
  }

  it('lets only the two people in a conversation open its image', async () => {
    const reference = await upload('sender', 'message-attachment');
    expect(reference).toMatch(/^\/uploads\/messages\//);

    const sent = await request(server())
      .post('/api/v1/messages')
      .set(as('sender'))
      .send({ recipientId: userIdOf.recipient, attachmentUrl: reference });
    expect(sent.status).toBe(201);

    const get = (who?: string) => {
      const r = request(server()).get(privatePath(reference));
      return who ? r.set(as(who)) : r;
    };
    for (const who of ['sender', 'recipient']) {
      const res = await get(who);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
      expect(res.headers['cache-control']).toBe('private, no-store');
    }
    for (const who of ['outsider', 'artisan', 'admin']) {
      expect((await get(who)).status).toBe(404);
    }
    expect((await get()).status).toBe(401);
    expect((await request(server()).get(reference)).status).toBe(404);
  });

  it("answers a file nobody has shared like one that doesn't exist", async () => {
    const reference = await upload('sender', 'message-attachment');
    expect(
      (await request(server()).get(privatePath(reference)).set(as('sender')))
        .status,
    ).toBe(404);
  });

  it('shows job photos to people who can see the job, and no one else', async () => {
    const reference = await upload('sender', 'job-attachment');
    const posted = await request(server())
      .post('/api/v1/jobs')
      .set(as('sender'))
      .send({
        title: `Retile the kitchen splashback ${uniq}`,
        description: 'Cracked tiles behind the cooker need replacing',
        serviceId,
        location: 'Adenta, Accra',
        budgetMin: 300,
        budgetMax: 450,
        currency: 'GHS',
        attachmentUrls: [reference],
      });
    expect(posted.status).toBe(201);
    const jobId = (posted.body as { data: { id: number } }).data.id;

    const status = async (who: string) =>
      (await request(server()).get(privatePath(reference)).set(as(who))).status;
    expect(await status('sender')).toBe(200);
    expect(await status('artisan')).toBe(200); // open job: on the job board
    expect(await status('admin')).toBe(200);
    expect(await status('outsider')).toBe(404);

    await request(server())
      .patch(`/api/v1/jobs/${jobId}/cancel`)
      .set(as('sender'));
    expect(await status('artisan')).toBe(404); // no longer open, never applied
    expect(await status('sender')).toBe(200);
  });
});
