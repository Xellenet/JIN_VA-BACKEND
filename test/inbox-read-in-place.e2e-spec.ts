/**
 * Customer Experience v2, reading in place from the bell and envelope menus,
 * over real HTTP and the in-memory database.
 *
 * Covers E-6.1 to E-6.6 (E-6.6 is B8 `GET /notifications/:id`) and M1
 * (`PATCH /messages/:id/read?upToMessageId=`). Every person and message here
 * is fictional.
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
import { Notification } from '../src/notifications/entities/notification.entity';
import { NotificationType, Role } from '@common/types/enums';
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

const PREFIX = 'cx2in-';

describe('Inbox read in place (E-6.x, B8, M1)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let notifications: Repository<Notification>;
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const ids: Record<string, number> = {};
  const emails: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });

  const send = (who: string, recipient: string, content: string) =>
    request(server())
      .post('/api/v1/messages')
      .set(as(who))
      .send({ recipientId: ids[recipient], content });

  const readFlags = (conversationId: number) =>
    dataSource.query<
      Array<{ id: number; sender_id: number; is_read: boolean }>
    >(
      'SELECT id, sender_id, is_read FROM messages WHERE conversation_id = $1 ORDER BY id',
      [conversationId],
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
    notifications = moduleFixture.get(getRepositoryToken(Notification));

    const users: Repository<User> = moduleFixture.get(getRepositoryToken(User));
    const profiles: Repository<ArtisanProfile> = moduleFixture.get(
      getRepositoryToken(ArtisanProfile),
    );
    const tokens = moduleFixture.get(UserTokenService);
    const make = async (label: string, role: Role) => {
      emails[label] = `${PREFIX}${label}-${uniq}@test.jinva.local`;
      const u = await users.save(
        users.create({
          email: emails[label],
          username: `cx2in${label}${uniq}`,
          firstname: 'Yaw',
          lastname: 'Darko',
          role,
          accountVerified: true,
        }),
      );
      ids[label] = u.id;
      if (role === Role.ARTISAN) {
        await profiles.save(profiles.create({ user: u, hourlyRate: 90 }));
      }
      token[label] = (await tokens.createJWTTokens(u)).access_token;
    };
    await make('a', Role.CUSTOMER);
    await make('b', Role.CUSTOMER);
    await make('k', Role.ARTISAN);
  });

  afterAll(async () => {
    await removeTestData(dataSource, {
      userIds: await testUserIds(dataSource, PREFIX),
    });
    await app.close();
  });

  const long =
    `Hello Yaw here. ${'The tiles arrive on Tuesday morning. '.repeat(20)}`.slice(
      0,
      600,
    );

  it('E-6.1: the conversation list carries the full 600-character last message', async () => {
    expect(long).toHaveLength(600);
    expect((await send('k', 'a', long)).status).toBe(201);

    const res = await request(server())
      .get('/api/v1/messages?page=1&limit=50')
      .set(as('a'));
    expect(res.status).toBe(200);
    const convo = (
      body(res).data as unknown as Array<{
        lastMessage: { content: string };
        unreadCount: number;
      }>
    ).find((c) => c.lastMessage?.content === long);
    expect(convo).toBeDefined();
    expect(convo!.unreadCount).toBeGreaterThanOrEqual(1);
  });

  it('E-6.2 / E-6.3: the notification feed carries body, payload and createdAt, and chat messages stay in Messages', async () => {
    // A new message no longer creates a notification row (it lives in
    // Messages, with its own unread badge). Give the feed a real item to
    // carry, plus a MESSAGE_RECEIVED row as an older build would have left.
    await notifications.save([
      notifications.create({
        user: { id: ids.a } as User,
        type: NotificationType.BOOKING_CONFIRMED,
        title: 'Booking confirmed',
        body: 'Your booking for Tuesday morning is confirmed.',
        isRead: false,
        payload: { bookingId: 4101 },
      }),
      notifications.create({
        user: { id: ids.a } as User,
        type: NotificationType.MESSAGE_RECEIVED,
        title: 'New message from Yaw Darko',
        body: '"The tiles arrive on Tuesday morning."',
        isRead: false,
        payload: { conversationId: 1 },
      }),
    ]);
    // Give any (now absent) async listener time to have written a row.
    await new Promise((r) => setTimeout(r, 300));
    const rows = await notifications.find({
      where: { user: { id: ids.a }, type: NotificationType.MESSAGE_RECEIVED },
    });
    // Only the legacy row inserted above: the message sent in E-6.1 made none.
    expect(rows).toHaveLength(1);

    const res = await request(server())
      .get('/api/v1/notifications?page=1&limit=5')
      .set(as('a'));
    expect(res.status).toBe(200);
    const items = body(res).data as unknown as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    expect(
      items.find((n) => n.type === NotificationType.MESSAGE_RECEIVED),
    ).toBeUndefined();
    expect(
      items.find((n) => n.type === NotificationType.BOOKING_CONFIRMED),
    ).toBeDefined();
    for (const item of items) {
      expect(item).toHaveProperty('body');
      expect(item).toHaveProperty('payload');
      expect(typeof item.createdAt).toBe('string');
    }

    // The bell counts the booking, not the message.
    const count = await request(server())
      .get('/api/v1/notifications/unread-count')
      .set(as('a'));
    expect(body(count).data).toEqual({ count: 1 });
  });

  describe('B8 GET /notifications/:id (E-6.6)', () => {
    let mine: Notification;
    let theirs: Notification;

    beforeAll(async () => {
      mine = await notifications.save(
        notifications.create({
          user: { id: ids.a } as User,
          type: NotificationType.DISPUTE_RESOLVED,
          title: 'Dispute resolved',
          body: "Your dispute on 'Fix leaking kitchen tap' was resolved in your favour.",
          isRead: false,
          payload: { jobId: 812 },
        }),
      );
      theirs = await notifications.save(
        notifications.create({
          user: { id: ids.b } as User,
          type: NotificationType.DISPUTE_RESOLVED,
          title: 'Dispute resolved',
          body: 'Not yours.',
          isRead: false,
          payload: { jobId: 813 },
        }),
      );
    });

    it('returns my own notification in full and does not mark it read', async () => {
      const res = await request(server())
        .get(`/api/v1/notifications/${mine.id}`)
        .set(as('a'));
      expect(res.status).toBe(200);
      // SEC-26: personal content is never kept by a shared or browser cache.
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(body(res).message).toBe('Notification retrieved');
      expect(body(res).data).toMatchObject({
        id: mine.id,
        type: 'DISPUTE_RESOLVED',
        title: 'Dispute resolved',
        isRead: false,
        payload: { jobId: 812 },
      });
      expect(typeof body(res).data.createdAt).toBe('string');
      expectNoForbiddenFields(res.body, { forbiddenValues: [emails.a] });
      const row = await notifications.findOneByOrFail({ id: mine.id });
      expect(row.isRead).toBe(false);
    });

    it("gives the same 404 for someone else's and a missing notification", async () => {
      const other = await request(server())
        .get(`/api/v1/notifications/${theirs.id}`)
        .set(as('a'));
      const missing = await request(server())
        .get('/api/v1/notifications/2147480000')
        .set(as('a'));
      expect(other.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(body(other).message).toBe(body(missing).message);
    });

    it('400 for a non-integer id, 401 without a token', async () => {
      expect(
        (await request(server()).get('/api/v1/notifications/abc').set(as('a')))
          .status,
      ).toBe(400);
      expect(
        (await request(server()).get(`/api/v1/notifications/${mine.id}`))
          .status,
      ).toBe(401);
    });

    it('the static routes still win over :id', async () => {
      const count = await request(server())
        .get('/api/v1/notifications/unread-count')
        .set(as('a'));
      expect(count.status).toBe(200);
      expect(typeof body(count).data.count).toBe('number');
      const prefs = await request(server())
        .get('/api/v1/notifications/preferences')
        .set(as('a'));
      expect(prefs.status).toBe(200);
    });

    it("E-6.4: marking someone else's notification read is 404 and leaves it unread", async () => {
      const res = await request(server())
        .patch(`/api/v1/notifications/${theirs.id}/read`)
        .set(as('a'));
      expect(res.status).toBe(404);
      const row = await notifications.findOneByOrFail({ id: theirs.id });
      expect(row.isRead).toBe(false);
    });
  });

  describe('M1 PATCH /messages/:id/read?upToMessageId', () => {
    let conversationId = 0;
    const sent: number[] = [];

    beforeAll(async () => {
      for (const text of ['First note', 'Second note', 'Third note']) {
        const res = await send('k', 'b', text);
        expect(res.status).toBe(201);
        const data = body(res).data as unknown as {
          id: number;
          conversationId?: number;
          conversation?: { id: number };
        };
        sent.push(data.id);
        conversationId = data.conversationId ?? data.conversation?.id ?? 0;
      }
      if (!conversationId) {
        const rows = await dataSource.query<Array<{ conversation_id: number }>>(
          'SELECT conversation_id FROM messages WHERE id = $1',
          [sent[0]],
        );
        conversationId = rows[0].conversation_id;
      }
      // B's own reply must never be touched by B's mark-read.
      expect((await send('b', 'k', 'Thanks, noted')).status).toBe(201);
    });

    it('with the bound, only messages up to that id from the other person are marked read', async () => {
      const res = await request(server())
        .patch(
          `/api/v1/messages/${conversationId}/read?upToMessageId=${sent[1]}`,
        )
        .set(as('b'));
      expect(res.status).toBe(200);
      const flags = await readFlags(conversationId);
      const byId = new Map(flags.map((f) => [f.id, f]));
      expect(byId.get(sent[0])!.is_read).toBe(true);
      expect(byId.get(sent[1])!.is_read).toBe(true);
      expect(byId.get(sent[2])!.is_read).toBe(false);
      // B's own message is untouched (the artisan has not read it).
      const own = flags.find((f) => f.sender_id === ids.b);
      expect(own?.is_read).toBe(false);
    });

    it('rejects a bad bound with 400 and changes nothing', async () => {
      for (const bad of ['0', '-3', 'abc', '1.5']) {
        const res = await request(server())
          .patch(`/api/v1/messages/${conversationId}/read?upToMessageId=${bad}`)
          .set(as('b'));
        expect(res.status).toBe(400);
      }
      const flags = await readFlags(conversationId);
      expect(flags.find((f) => f.id === sent[2])!.is_read).toBe(false);
    });

    it('without the bound, behaves exactly as before: every unread message from the other person', async () => {
      const res = await request(server())
        .patch(`/api/v1/messages/${conversationId}/read`)
        .set(as('b'));
      expect(res.status).toBe(200);
      expect(body(res).message).toBe('Messages marked as read.');
      const flags = await readFlags(conversationId);
      for (const f of flags.filter((x) => x.sender_id === ids.k)) {
        expect(f.is_read).toBe(true);
      }
      expect(flags.find((f) => f.sender_id === ids.b)!.is_read).toBe(false);
    });

    it('E-6.5: a non-participant cannot mark the conversation read, and nothing changes', async () => {
      await send('k', 'b', 'Fourth note');
      const before = await readFlags(conversationId);
      const res = await request(server())
        .patch(
          `/api/v1/messages/${conversationId}/read?upToMessageId=${2147480000}`,
        )
        .set(as('a'));
      expect([403, 404]).toContain(res.status);
      expect(await readFlags(conversationId)).toEqual(before);
    });
  });
});
