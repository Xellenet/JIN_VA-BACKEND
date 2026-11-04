/**
 * Replying to a specific message, and the artisan profile ids a customer
 * needs to open an artisan's profile from a chat, a job or its applications.
 * Real HTTP against the in-memory database; every person here is fictional.
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
import { ServiceEntity } from '@services/entities/service.entity';
import { Job } from '@jobs/entities/job.entity';
import { JobApplication } from '@jobs/entities/job-application.entity';
import { ApplicationStatus, Role, Status } from '@common/types/enums';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(120000);

const PREFIX = 'mreply-';

type ReplyTo = {
  id: number | null;
  senderId: number | null;
  senderName: string | null;
  preview: string | null;
  deleted: boolean;
} | null;
type Msg = {
  id: number;
  content: string | null;
  replyTo: ReplyTo;
};
type Conversation = {
  id: number;
  contact: { id?: number; artisanProfileId?: number | null };
  lastMessage: { id: number; replyTo: ReplyTo } | null;
};

const data = <T>(res: request.Response): T => (res.body as { data: T }).data;

describe('Message replies and artisan profile links (e2e)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const ids: Record<string, number> = {};
  const profileIds: Record<string, number> = {};
  let serviceId = 0;
  let jobId = 0;
  let openJobId = 0;
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });

  const send = (who: string, to: string, body: Record<string, unknown>) =>
    request(server())
      .post('/api/v1/messages')
      .set(as(who))
      .send({ recipientId: ids[to], ...body });

  const thread = async (who: string, conversationId: number) => {
    const res = await request(server())
      .get(`/api/v1/messages/${conversationId}?page=1&limit=50`)
      .set(as(who));
    expect(res.status).toBe(200);
    return data<Msg[]>(res);
  };

  const conversationIdOf = async (messageId: number) => {
    const rows = await dataSource.query<Array<{ conversation_id: number }>>(
      'SELECT conversation_id FROM messages WHERE id = $1',
      [messageId],
    );
    return Number(rows[0].conversation_id);
  };

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

    const users: Repository<User> = moduleFixture.get(getRepositoryToken(User));
    const profiles: Repository<ArtisanProfile> = moduleFixture.get(
      getRepositoryToken(ArtisanProfile),
    );
    const tokens = moduleFixture.get(UserTokenService);
    const make = async (
      label: string,
      role: Role,
      firstname: string,
      lastname: string,
    ) => {
      const u = await users.save(
        users.create({
          email: `${PREFIX}${label}-${uniq}@test.jinva.local`,
          username: `mreply${label}${uniq}`,
          firstname,
          lastname,
          role,
          accountVerified: true,
        }),
      );
      ids[label] = u.id;
      if (role === Role.ARTISAN) {
        const p = await profiles.save(
          profiles.create({ user: u, hourlyRate: 80 }),
        );
        profileIds[label] = p.id;
      }
      token[label] = (await tokens.createJWTTokens(u)).access_token;
      return u;
    };
    const customer = await make('c', Role.CUSTOMER, 'Efua', 'Mensah');
    await make('c2', Role.CUSTOMER, 'Kojo', 'Asante');
    const artisan = await make('k', Role.ARTISAN, 'Kwame', 'Badu');
    const applicant = await make('k2', Role.ARTISAN, 'Akosua', 'Frimpong');

    const services: Repository<ServiceEntity> = moduleFixture.get(
      getRepositoryToken(ServiceEntity),
    );
    const service = await services.save(
      services.create({
        name: `Message replies ${uniq}`,
        estimatedDurationMins: 60,
      }),
    );
    serviceId = service.id;
    const jobs: Repository<Job> = moduleFixture.get(getRepositoryToken(Job));
    const base = {
      customer,
      service,
      description: 'Replace two cracked bathroom tiles',
      location: 'Labone, Greater Accra',
      currency: 'GHS',
    };
    jobId = (
      await jobs.save(
        jobs.create({
          ...base,
          title: `Tiles ${uniq}`,
          status: Status.IN_PROGRESS,
          acceptedArtisan: artisan,
        }),
      )
    ).id;
    openJobId = (
      await jobs.save(
        jobs.create({ ...base, title: `Grout ${uniq}`, status: Status.OPEN }),
      )
    ).id;
    const apps: Repository<JobApplication> = moduleFixture.get(
      getRepositoryToken(JobApplication),
    );
    await apps.save(
      apps.create({
        job: { id: openJobId } as Job,
        artisan: applicant,
        status: ApplicationStatus.PENDING,
      }),
    );
  });

  afterAll(async () => {
    await removeTestData(dataSource, {
      userIds: await testUserIds(dataSource, PREFIX),
      serviceIds: serviceId ? [serviceId] : [],
    });
    await app.close();
  });

  let conversationId = 0;
  let originalId = 0;

  it('a reply to a message in the same conversation carries its quote', async () => {
    const first = await send('k', 'c', {
      content: 'I can come on Thursday at nine to look at the tiles.',
    });
    expect(first.status).toBe(201);
    originalId = data<Msg>(first).id;
    expect(data<Msg>(first).replyTo).toBeNull();
    conversationId = await conversationIdOf(originalId);

    const reply = await send('c', 'k', {
      content: 'Thursday works.',
      replyToMessageId: originalId,
    });
    expect(reply.status).toBe(201);
    expect(data<Msg>(reply).replyTo).toEqual({
      id: originalId,
      senderId: ids.k,
      senderName: 'Kwame Badu',
      preview: 'I can come on Thursday at nine to look at the tiles.',
      deleted: false,
    });

    const msgs = await thread('k', conversationId);
    expect(msgs.find((m) => m.id === data<Msg>(reply).id)?.replyTo?.id).toBe(
      originalId,
    );
    expect(msgs.find((m) => m.id === originalId)?.replyTo).toBeNull();
  });

  it('the conversation list carries the last message quote and the artisan profile id', async () => {
    const asCustomer = await request(server())
      .get('/api/v1/messages?page=1&limit=50')
      .set(as('c'));
    expect(asCustomer.status).toBe(200);
    const row = data<Conversation[]>(asCustomer).find(
      (c) => c.id === conversationId,
    );
    expect(row?.contact.artisanProfileId).toBe(profileIds.k);
    expect(row?.lastMessage?.replyTo).toMatchObject({
      id: originalId,
      deleted: false,
    });

    const asArtisan = await request(server())
      .get('/api/v1/messages?page=1&limit=50')
      .set(as('k'));
    const theirRow = data<Conversation[]>(asArtisan).find(
      (c) => c.id === conversationId,
    );
    // Clients have no public profile page.
    expect(theirRow?.contact.artisanProfileId).toBeNull();
  });

  it("rejects a reply to another conversation's message with a 400 that leaks nothing", async () => {
    const elsewhere = await send('k', 'c2', {
      content: 'Private note for Kojo about the gate code.',
    });
    expect(elsewhere.status).toBe(201);
    const foreignId = data<Msg>(elsewhere).id;

    const res = await send('c', 'k', {
      content: 'Quoting a thread I am not in',
      replyToMessageId: foreignId,
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(
      'You can only reply to a message in this conversation.',
    );
    expect(JSON.stringify(res.body)).not.toContain('gate code');

    // A missing id reads exactly the same.
    const missing = await send('c', 'k', {
      content: 'Quoting nothing',
      replyToMessageId: 2147480000,
    });
    expect(missing.status).toBe(400);
    expect((missing.body as { message: unknown }).message).toEqual(
      (res.body as { message: unknown }).message,
    );
  });

  it('rejects a reply in a conversation that does not exist yet', async () => {
    const res = await send('c2', 'k2', {
      content: 'Hello',
      replyToMessageId: originalId,
    });
    expect(res.status).toBe(400);
    const rows = await dataSource.query<Array<{ n: string }>>(
      `SELECT COUNT(*) AS n FROM conversations
        WHERE (participant_a_id = $1 AND participant_b_id = $2)
           OR (participant_a_id = $2 AND participant_b_id = $1)`,
      [ids.c2, ids.k2],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('rejects a malformed replyToMessageId', async () => {
    for (const bad of [0, -1, 'abc', 1.5]) {
      const res = await send('c', 'k', {
        content: 'Hi',
        replyToMessageId: bad,
      });
      expect(res.status).toBe(400);
    }
  });

  it('a reply whose original was deleted still loads, marked deleted', async () => {
    const original = await send('k', 'c', { content: 'Bring the grey grout.' });
    const originalMsgId = data<Msg>(original).id;
    const reply = await send('c', 'k', {
      content: 'Will do.',
      replyToMessageId: originalMsgId,
    });
    expect(reply.status).toBe(201);
    const replyId = data<Msg>(reply).id;

    await dataSource.query('DELETE FROM messages WHERE id = $1', [
      originalMsgId,
    ]);

    const msgs = await thread('c', conversationId);
    expect(msgs.find((m) => m.id === replyId)?.replyTo).toEqual({
      id: null,
      senderId: null,
      senderName: null,
      preview: null,
      deleted: true,
    });
  });

  it('a photo-only original is quoted as "Photo"', async () => {
    const [row] = await dataSource.query<Array<{ id: number }>>(
      `INSERT INTO messages (conversation_id, sender_id, content, attachment_url, attachment_type)
       VALUES ($1, $2, NULL, '/uploads/messages/3f1e6c1a-1c2b-4d8e-9a7f-0b1c2d3e4f56.png', 'image/png')
       RETURNING id`,
      [conversationId, ids.k],
    );
    const reply = await send('c', 'k', {
      content: 'Nice work',
      replyToMessageId: row.id,
    });
    expect(reply.status).toBe(201);
    expect(data<Msg>(reply).replyTo).toMatchObject({
      preview: 'Photo',
      deleted: false,
    });
  });

  it("the job's accepted artisan carries the artisan profile id", async () => {
    const res = await request(server())
      .get(`/api/v1/jobs/${jobId}`)
      .set(as('c'));
    expect(res.status).toBe(200);
    expect(
      data<{ acceptedArtisan: { id: number; artisanProfileId: number } }>(res)
        .acceptedArtisan,
    ).toMatchObject({ id: ids.k, artisanProfileId: profileIds.k });
  });

  it("each job application carries the applicant's artisan profile id", async () => {
    const res = await request(server())
      .get(`/api/v1/jobs/${openJobId}/applications`)
      .set(as('c'));
    expect(res.status).toBe(200);
    const [application] =
      data<Array<{ artisan: { id: number }; artisanProfileId: number }>>(res);
    expect(application.artisan.id).toBe(ids.k2);
    expect(application.artisanProfileId).toBe(profileIds.k2);
  });
});
