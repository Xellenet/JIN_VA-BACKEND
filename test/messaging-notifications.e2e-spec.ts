import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { Job } from '@jobs/entities/job.entity';
import { Booking } from '../src/bookings/entities/booking.entity';
import { Dispute } from '../src/disputes/entities/dispute.entity';
import { Message } from '@messages/entities/message.entity';
import { Conversation } from '@messages/entities/conversation.entity';
import { Notification } from '../src/notifications/entities/notification.entity';
import { UserTokenService } from '@users/token.service';
import { MailService } from '../src/mail/mail.service';
import {
  Role,
  Status,
  BookingStatus,
  DisputeStatus,
} from '@common/types/enums';

/**
 * QA verification (messaging-notifications, docs/team/messaging-notifications).
 *
 * REAL end-to-end HTTP requests via supertest against a live Nest application
 * on the real Postgres connection — not unit tests with mocked repositories.
 *
 * Covers the backend half of the acceptance criteria this feature's Definition
 * of Done names:
 *   MB1  canonical /messages send emits MESSAGE_RECEIVED -> the recipient gets
 *        a real in-app notification row without ever opening Messages
 *   MB1  /direct-messages/* is really gone (404, not merely unused)
 *   MB2  same-role messaging (customer<->customer, artisan<->artisan) rejected
 *   MB3  conversation list is server-paginated with meta.pagination
 *   MC2  job/booking context rides on the message; non-participant -> 403
 *   MC3  1-2000 char bound preserved
 *   MC4  image attachment upload (JPEG/PNG, 5MB), wrong-type + oversize
 *        rejection, image-only message, forged attachmentUrl rejected
 *   MR1  mark-read only clears the *other* participant's messages
 *   MR2  isRead is returned per message (the tick's only data source)
 *   AD1  admin dispute-conversation viewer + "no conversation on file" null
 *   AD2  scope boundary: non-admin 403; resolved/closed dispute 403; no
 *        parameter exists to reach an unrelated dispute's thread
 *   PD4  dispute resolved/closed notifies BOTH parties
 *   RL1  rate limit returns the documented MESSAGE_RATE_LIMIT_EXCEEDED body
 *   Perm a third party cannot read someone else's conversation
 *
 * Run: npm run test:e2e -- messaging-notifications
 *
 * QA test code only (per QA's role boundary) — no application/feature code is
 * touched by this file. Every fixture created here is removed in `afterAll`.
 */
jest.setTimeout(120000);

interface Envelope<T> {
  data: T;
  message?: string;
  meta?: {
    pagination?: {
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };
  };
}

interface MiniMessage {
  id: number;
  content: string | null;
  attachmentUrl: string | null;
  attachmentType: string | null;
  jobId: number | null;
  bookingId: number | null;
  isRead: boolean;
  createdAt: string;
  sender?: { id: number };
}

interface MiniConversation {
  id: number;
  contact: { id: number; role?: string };
  lastMessage: {
    id: number;
    content: string | null;
    attachmentUrl: string | null;
    senderId: number;
    isRead: boolean;
  } | null;
  unreadCount: number;
  lastMessageAt: string | null;
}

interface MiniDisputeConversation {
  conversationId: number;
  disputeId: number;
  bookingId: number;
  customer: { id: number; role: string };
  artisan: { id: number; role: string };
  totalMessages: number;
  messages: MiniMessage[];
  readOnly: boolean;
}

function envelope<T>(res: request.Response): T {
  return (res.body as Envelope<T>).data;
}
function meta(res: request.Response) {
  return (res.body as Envelope<unknown>).meta;
}
function envelopeMessage(res: request.Response): string | undefined {
  return (res.body as Envelope<unknown>).message;
}

describe('Messaging & Notifications — full lifecycle (e2e)', () => {
  let app: INestApplication<App>;

  let userRepo: Repository<User>;
  let profileRepo: Repository<ArtisanProfile>;
  let serviceRepo: Repository<ServiceEntity>;
  let jobRepo: Repository<Job>;
  let bookingRepo: Repository<Booking>;
  let disputeRepo: Repository<Dispute>;
  let messageRepo: Repository<Message>;
  let conversationRepo: Repository<Conversation>;
  let notificationRepo: Repository<Notification>;
  let tokenService: UserTokenService;

  let artisanUser: User;
  let artisanProfile: ArtisanProfile;
  let artisanToken: string;
  let artisan2User: User;
  let customer1: User;
  let customer1Token: string;
  let customer2: User;
  let customer2Token: string;
  let adminUser: User;
  let adminToken: string;
  let service: ServiceEntity;

  const createdConversationIds: number[] = [];
  const createdDisputeIds: number[] = [];
  const createdBookingIds: number[] = [];
  const createdJobIds: number[] = [];

  const server = () => app.getHttpServer();
  const uniq = Date.now();

  /** Minimal genuinely-valid 1x1 PNG (passes `file-type` magic-byte sniffing). */
  const VALID_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );

  async function makeUser(
    label: string,
    role: Role,
  ): Promise<{ user: User; token: string }> {
    const user = await userRepo.save(
      userRepo.create({
        email: `qa-msg-${label}-${uniq}@test.jinva.local`,
        password: null,
        firstname: 'QaMsg',
        lastname: label,
        role,
        accountVerified: true,
        isBanned: false,
      }),
    );
    const token = (await tokenService.createJWTTokens(user)).access_token;
    return { user, token };
  }

  async function notificationsFor(
    userId: number,
    type?: string,
  ): Promise<Notification[]> {
    const where: Record<string, unknown> = { user: { id: userId } };
    if (type) where.type = type;
    return notificationRepo.find({
      where,
      order: { createdAt: 'DESC', id: 'DESC' },
    });
  }

  async function send(
    token: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(server())
      .post('/api/v1/messages')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix('api/v1', { exclude: ['/'] });
    await app.init();

    userRepo = moduleFixture.get(getRepositoryToken(User));
    profileRepo = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    serviceRepo = moduleFixture.get(getRepositoryToken(ServiceEntity));
    jobRepo = moduleFixture.get(getRepositoryToken(Job));
    bookingRepo = moduleFixture.get(getRepositoryToken(Booking));
    disputeRepo = moduleFixture.get(getRepositoryToken(Dispute));
    messageRepo = moduleFixture.get(getRepositoryToken(Message));
    conversationRepo = moduleFixture.get(getRepositoryToken(Conversation));
    notificationRepo = moduleFixture.get(getRepositoryToken(Notification));
    tokenService = moduleFixture.get(UserTokenService);

    service = await serviceRepo.save(
      serviceRepo.create({
        name: `QA Messaging Test Service ${uniq}`,
        estimatedDurationMins: 60,
      }),
    );

    ({ user: artisanUser, token: artisanToken } = await makeUser(
      'Artisan',
      Role.ARTISAN,
    ));
    artisanProfile = await profileRepo.save(
      profileRepo.create({
        user: artisanUser,
        currency: 'GHS',
        isVerified: true,
        isProfileComplete: true,
      }),
    );

    ({ user: artisan2User } = await makeUser('ArtisanTwo', Role.ARTISAN));
    await profileRepo.save(
      profileRepo.create({
        user: artisan2User,
        currency: 'GHS',
        isVerified: true,
        isProfileComplete: true,
      }),
    );

    ({ user: customer1, token: customer1Token } = await makeUser(
      'CustomerOne',
      Role.CUSTOMER,
    ));
    ({ user: customer2, token: customer2Token } = await makeUser(
      'CustomerTwo',
      Role.CUSTOMER,
    ));
    ({ user: adminUser, token: adminToken } = await makeUser(
      'Admin',
      Role.ADMIN,
    ));
  });

  afterAll(async () => {
    const ignore = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* row already gone / FK ordering */
      }
    };

    await ignore(() =>
      notificationRepo
        .createQueryBuilder()
        .delete()
        .where('user_id IN (:...ids)', {
          ids: [
            artisanUser.id,
            artisan2User.id,
            customer1.id,
            customer2.id,
            adminUser.id,
          ],
        })
        .execute(),
    );
    if (createdConversationIds.length) {
      await ignore(() =>
        messageRepo
          .createQueryBuilder()
          .delete()
          .where('conversation_id IN (:...ids)', {
            ids: createdConversationIds,
          })
          .execute(),
      );
      await ignore(() =>
        conversationRepo.delete({ id: In(createdConversationIds) }),
      );
    }
    if (createdDisputeIds.length) {
      await ignore(() => disputeRepo.delete({ id: In(createdDisputeIds) }));
    }
    if (createdJobIds.length) {
      await ignore(() => jobRepo.delete({ id: In(createdJobIds) }));
    }
    if (createdBookingIds.length) {
      await ignore(() => bookingRepo.delete({ id: In(createdBookingIds) }));
    }
    await ignore(() => profileRepo.delete({ user: { id: artisanUser.id } }));
    await ignore(() => profileRepo.delete({ user: { id: artisan2User.id } }));
    await ignore(() =>
      userRepo.delete({
        id: In([
          artisanUser.id,
          artisan2User.id,
          customer1.id,
          customer2.id,
          adminUser.id,
        ]),
      }),
    );
    await ignore(() => serviceRepo.delete({ id: service.id }));
    await app.close();
  });

  // ── MB1: the retired module is really gone ────────────────────────────────

  it('MB1: every /direct-messages/* route is gone (404), so any frontend still calling it is broken', async () => {
    const routes: [string, string][] = [
      ['get', '/api/v1/direct-messages/conversations'],
      ['get', `/api/v1/direct-messages/${artisanUser.id}`],
      ['post', `/api/v1/direct-messages/${artisanUser.id}`],
      ['patch', `/api/v1/direct-messages/${artisanUser.id}/read`],
    ];
    for (const [method, path] of routes) {
      const res = await (
        request(server()) as unknown as Record<
          string,
          (p: string) => request.Test
        >
      )
        [method](path)
        .set('Authorization', `Bearer ${customer1Token}`)
        .send({ content: 'hello' });
      expect([404]).toContain(res.status);
    }
  });

  // ── MB1 headline: send -> recipient gets a real in-app notification ───────

  it('MB1 (HEADLINE): a customer sending to an artisan creates a MESSAGE_RECEIVED notification row for the artisan without the artisan ever calling Messages', async () => {
    const before = await notificationsFor(artisanUser.id, 'MESSAGE_RECEIVED');

    const res = await send(customer1Token, {
      recipientId: artisanUser.id,
      content: 'QA headline check: are you free on Thursday?',
    });
    expect(res.status).toBe(201);
    const msg = envelope<MiniMessage>(res);
    expect(msg.id).toBeGreaterThan(0);
    expect(msg.content).toBe('QA headline check: are you free on Thursday?');
    expect(msg.isRead).toBe(false);

    // The event listener is async — poll briefly rather than assume timing.
    let after = before;
    for (let i = 0; i < 20 && after.length === before.length; i++) {
      await new Promise((r) => setTimeout(r, 250));
      after = await notificationsFor(artisanUser.id, 'MESSAGE_RECEIVED');
    }
    expect(after.length).toBe(before.length + 1);
    expect(after[0].title).toContain('QaMsg');
    expect(after[0].body).toContain('Thursday');
    expect(after[0].isRead).toBe(false);
    expect(
      (after[0].payload as { conversationId?: number } | null)?.conversationId,
    ).toBeGreaterThan(0);

    // Same in the other direction (artisan -> customer).
    const beforeCust = await notificationsFor(customer1.id, 'MESSAGE_RECEIVED');
    const reply = await send(artisanToken, {
      recipientId: customer1.id,
      content: 'Yes, Thursday works.',
    });
    expect(reply.status).toBe(201);
    let afterCust = beforeCust;
    for (let i = 0; i < 20 && afterCust.length === beforeCust.length; i++) {
      await new Promise((r) => setTimeout(r, 250));
      afterCust = await notificationsFor(customer1.id, 'MESSAGE_RECEIVED');
    }
    expect(afterCust.length).toBe(beforeCust.length + 1);

    // Record the conversation for cleanup.
    const list = await request(server())
      .get('/api/v1/messages?page=1&limit=50')
      .set('Authorization', `Bearer ${customer1Token}`);
    for (const c of envelope<MiniConversation[]>(list)) {
      if (!createdConversationIds.includes(c.id)) {
        createdConversationIds.push(c.id);
      }
    }
    expect(createdConversationIds.length).toBeGreaterThan(0);
  });

  // ── MB2: same-role messaging rejected ─────────────────────────────────────

  it('MB2: customer -> customer is rejected with a clear message, not a generic failure', async () => {
    const res = await send(customer1Token, {
      recipientId: customer2.id,
      content: 'customer to customer',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(
      'Messages can only be exchanged between a customer and an artisan',
    );
  });

  it('MB2: artisan -> artisan is rejected the same way', async () => {
    const res = await send(artisanToken, {
      recipientId: artisan2User.id,
      content: 'artisan to artisan',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(
      'Messages can only be exchanged between a customer and an artisan',
    );
  });

  it('MB2: admin -> artisan and admin -> customer are also rejected (admin is neither side of the allowed pair)', async () => {
    const toArtisan = await send(adminToken, {
      recipientId: artisanUser.id,
      content: 'admin to artisan',
    });
    const toCustomer = await send(adminToken, {
      recipientId: customer1.id,
      content: 'admin to customer',
    });
    expect(toArtisan.status).toBe(400);
    expect(toCustomer.status).toBe(400);
  });

  it('messaging yourself is rejected', async () => {
    const res = await send(customer1Token, {
      recipientId: customer1.id,
      content: 'note to self',
    });
    expect(res.status).toBe(400);
  });

  it('a nonexistent recipient returns 404 (deep-link with a bad id must not 500)', async () => {
    const res = await send(customer1Token, {
      recipientId: 2147483000,
      content: 'ghost',
    });
    expect(res.status).toBe(404);
  });

  // ── MB3: pagination ───────────────────────────────────────────────────────

  it('MB3: GET /messages is server-paginated and exposes meta.pagination', async () => {
    const res = await request(server())
      .get('/api/v1/messages?page=1&limit=1')
      .set('Authorization', `Bearer ${customer1Token}`);
    expect(res.status).toBe(200);
    const rows = envelope<MiniConversation[]>(res);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(1);
    const pagination = meta(res)?.pagination;
    expect(pagination).toBeDefined();
    expect(pagination?.page).toBe(1);
    expect(pagination?.limit).toBe(1);
    expect(typeof pagination?.total).toBe('number');
  });

  it('MB3: limit above the documented max of 50 is rejected with 400', async () => {
    const res = await request(server())
      .get('/api/v1/messages?page=1&limit=500')
      .set('Authorization', `Bearer ${customer1Token}`);
    expect(res.status).toBe(400);
  });

  it('MB3: conversation rows carry contact (with role), lastMessage object and unreadCount', async () => {
    const res = await request(server())
      .get('/api/v1/messages?page=1&limit=50')
      .set('Authorization', `Bearer ${artisanToken}`);
    expect(res.status).toBe(200);
    const row = envelope<MiniConversation[]>(res).find(
      (c) => c.contact.id === customer1.id,
    );
    expect(row).toBeDefined();
    expect(row?.contact.role).toBe('CUSTOMER');
    expect(row?.lastMessage).not.toBeNull();
    expect(typeof row?.lastMessage?.senderId).toBe('number');
    expect(typeof row?.unreadCount).toBe('number');
  });

  // ── MC3: content bounds ───────────────────────────────────────────────────

  it('MC3: content over 2000 chars is rejected; exactly 2000 is accepted', async () => {
    const tooLong = await send(customer1Token, {
      recipientId: artisanUser.id,
      content: 'x'.repeat(2001),
    });
    expect(tooLong.status).toBe(400);

    const atLimit = await send(customer1Token, {
      recipientId: artisanUser.id,
      content: 'y'.repeat(2000),
    });
    expect(atLimit.status).toBe(201);
  });

  it('a message with neither text nor image is rejected', async () => {
    const res = await send(customer1Token, { recipientId: artisanUser.id });
    expect(res.status).toBe(400);
  });

  it('whitespace-only content with no image is rejected', async () => {
    const res = await send(customer1Token, {
      recipientId: artisanUser.id,
      content: '     ',
    });
    expect(res.status).toBe(400);
  });

  // ── MC4: image attachments ────────────────────────────────────────────────

  it('MC4: POST /uploads/message-attachment accepts a real PNG and returns a url', async () => {
    const res = await request(server())
      .post('/api/v1/uploads/message-attachment')
      .set('Authorization', `Bearer ${customer1Token}`)
      .attach('file', VALID_PNG, {
        filename: 'photo.png',
        contentType: 'image/png',
      });
    expect(res.status).toBe(200);
    const body = envelope<{ url: string; folder: string; bytes: number }>(res);
    expect(body.url).toContain('/uploads/messages/');
    expect(body.folder).toBe('messages');
  });

  it('MC4: a .jpg-named file that is not really an image is rejected (byte sniffing, not declared type)', async () => {
    const res = await request(server())
      .post('/api/v1/uploads/message-attachment')
      .set('Authorization', `Bearer ${customer1Token}`)
      .attach('file', Buffer.from('this is definitely not an image'), {
        filename: 'evil.jpg',
        contentType: 'image/jpeg',
      });
    expect(res.status).toBe(400);
  });

  it('MC4: a PDF is rejected', async () => {
    const res = await request(server())
      .post('/api/v1/uploads/message-attachment')
      .set('Authorization', `Bearer ${customer1Token}`)
      .attach('file', Buffer.from('%PDF-1.4\n%mock'), {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      });
    expect(res.status).toBe(400);
  });

  it('MC4: a file over 5MB is rejected (413 or 400, never accepted)', async () => {
    const oversize = Buffer.concat([
      VALID_PNG,
      Buffer.alloc(6 * 1024 * 1024, 0),
    ]);
    const res = await request(server())
      .post('/api/v1/uploads/message-attachment')
      .set('Authorization', `Bearer ${customer1Token}`)
      .attach('file', oversize, {
        filename: 'huge.png',
        contentType: 'image/png',
      });
    expect([400, 413]).toContain(res.status);
  });

  it('MC4: an image-only message (no text) is accepted and returns attachmentUrl/attachmentType with null content', async () => {
    const upload = await request(server())
      .post('/api/v1/uploads/message-attachment')
      .set('Authorization', `Bearer ${customer1Token}`)
      .attach('file', VALID_PNG, {
        filename: 'imageonly.png',
        contentType: 'image/png',
      });
    expect(upload.status).toBe(200);
    const url = envelope<{ url: string }>(upload).url;

    const res = await send(customer1Token, {
      recipientId: artisanUser.id,
      attachmentUrl: url,
    });
    expect(res.status).toBe(201);
    const msg = envelope<MiniMessage>(res);
    expect(msg.content).toBeNull();
    expect(msg.attachmentUrl).toBe(url);
    expect(msg.attachmentType).toBe('image/png');
  });

  it('MC4: an arbitrary/forged attachmentUrl is rejected', async () => {
    const res = await send(customer1Token, {
      recipientId: artisanUser.id,
      attachmentUrl: 'https://evil.example.com/payload.jpg',
    });
    expect(res.status).toBe(400);
  });

  /**
   * QA `qa-report.md` B2: `attachmentUrl` was validated by a bare
   * `startsWith('/uploads/')`, so any path under the uploads tree was accepted,
   * persisted and rendered — including in the admin dispute-evidence viewer.
   * This is QA's accepted/rejected table, run against the live API so the
   * guarantee in `api-contract.md` §3 is enforced in CI rather than by reading
   * the validator.
   */
  it.each([
    ['another folder (KYC documents)', '/uploads/documents/some-kyc-doc.pdf'],
    ['another folder (profiles)', '/uploads/profiles/ama-mensah.jpg'],
    [
      'another folder (portfolio)',
      '/uploads/portfolio/3f1e6c1a-1c2b-4d8e-9a7f-0b1c2d3e4f56.jpg',
    ],
    ['a traversal string', '/uploads/messages/../documents/secret.pdf'],
    [
      'an encoded traversal string',
      '/uploads/messages/%2e%2e/documents/secret.pdf',
    ],
    ['a filename we never minted', '/uploads/messages/does-not-exist.jpg'],
    [
      'an extension the upload endpoint cannot produce',
      '/uploads/messages/3f1e6c1a-1c2b-4d8e-9a7f-0b1c2d3e4f56.svg',
    ],
    [
      'a smuggled query string',
      '/uploads/messages/3f1e6c1a-1c2b-4d8e-9a7f-0b1c2d3e4f56.jpg?<script>alert(1)</script>',
    ],
    ['a protocol-relative host', '//evil.example/x.png'],
  ])('MC4/QA-B2: %s is rejected as an attachmentUrl', async (_label, url) => {
    const res = await send(customer1Token, {
      recipientId: artisanUser.id,
      content: 'probe',
      attachmentUrl: url,
    });
    expect(res.status).toBe(400);
  });

  // ── MC2: job/booking context ──────────────────────────────────────────────

  it('MC2: a jobId the sender participates in is stored on the message; a job they do not is 403', async () => {
    const job = await jobRepo.save(
      jobRepo.create({
        customer: customer1,
        service,
        status: Status.IN_PROGRESS,
        acceptedArtisan: artisanUser,
        title: `QA Msg Context Job ${uniq}`,
        location: 'QA Test Location, Accra',
        currency: 'GHS',
      }),
    );
    createdJobIds.push(job.id);

    const ok = await send(customer1Token, {
      recipientId: artisanUser.id,
      content: 'About this job',
      jobId: job.id,
    });
    expect(ok.status).toBe(201);
    expect(envelope<MiniMessage>(ok).jobId).toBe(job.id);

    const otherJob = await jobRepo.save(
      jobRepo.create({
        customer: customer2,
        service,
        status: Status.IN_PROGRESS,
        acceptedArtisan: artisan2User,
        title: `QA Msg Foreign Job ${uniq}`,
        location: 'QA Test Location, Accra',
        currency: 'GHS',
      }),
    );
    createdJobIds.push(otherJob.id);

    const forbidden = await send(customer1Token, {
      recipientId: artisanUser.id,
      content: 'Tagging a job I am not party to',
      jobId: otherJob.id,
    });
    expect(forbidden.status).toBe(403);
  });

  it('MC2: jobId and bookingId together are rejected', async () => {
    const res = await send(customer1Token, {
      recipientId: artisanUser.id,
      content: 'both',
      jobId: createdJobIds[0],
      bookingId: 1,
    });
    expect(res.status).toBe(400);
  });

  it('MC2: a general inquiry with no job/booking still works (pre-job messaging is not gated)', async () => {
    const res = await send(customer2Token, {
      recipientId: artisanUser.id,
      content: 'Hi, saw your profile — do you do tiling?',
    });
    expect(res.status).toBe(201);
    const msg = envelope<MiniMessage>(res);
    expect(msg.jobId).toBeNull();
    expect(msg.bookingId).toBeNull();

    const list = await request(server())
      .get('/api/v1/messages?page=1&limit=50')
      .set('Authorization', `Bearer ${customer2Token}`);
    for (const c of envelope<MiniConversation[]>(list)) {
      if (!createdConversationIds.includes(c.id)) {
        createdConversationIds.push(c.id);
      }
    }
  });

  // ── Thread read + permission boundary ─────────────────────────────────────

  it('GET /messages/:id returns the thread oldest-first with isRead per message (MR2 data source)', async () => {
    const list = await request(server())
      .get('/api/v1/messages?page=1&limit=50')
      .set('Authorization', `Bearer ${customer1Token}`);
    const conv = envelope<MiniConversation[]>(list).find(
      (c) => c.contact.id === artisanUser.id,
    );
    expect(conv).toBeDefined();

    const thread = await request(server())
      .get(`/api/v1/messages/${conv!.id}?page=1&limit=50`)
      .set('Authorization', `Bearer ${customer1Token}`);
    expect(thread.status).toBe(200);
    const msgs = envelope<MiniMessage[]>(thread);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(typeof m.isRead).toBe('boolean');
    const times = msgs.map((m) => new Date(m.createdAt).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(meta(thread)?.pagination).toBeDefined();
  });

  it('a third party cannot read a conversation they are not a participant of (403)', async () => {
    const list = await request(server())
      .get('/api/v1/messages?page=1&limit=50')
      .set('Authorization', `Bearer ${customer1Token}`);
    const conv = envelope<MiniConversation[]>(list).find(
      (c) => c.contact.id === artisanUser.id,
    );

    const asOtherCustomer = await request(server())
      .get(`/api/v1/messages/${conv!.id}`)
      .set('Authorization', `Bearer ${customer2Token}`);
    expect(asOtherCustomer.status).toBe(403);

    const asAdmin = await request(server())
      .get(`/api/v1/messages/${conv!.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(asAdmin.status).toBe(403);

    const markReadAsOther = await request(server())
      .patch(`/api/v1/messages/${conv!.id}/read`)
      .set('Authorization', `Bearer ${customer2Token}`);
    expect(markReadAsOther.status).toBe(403);
  });

  it('MR1: mark-read clears only the OTHER participant messages and zeroes that conversation unreadCount', async () => {
    const list = await request(server())
      .get('/api/v1/messages?page=1&limit=50')
      .set('Authorization', `Bearer ${artisanToken}`);
    const conv = envelope<MiniConversation[]>(list).find(
      (c) => c.contact.id === customer1.id,
    );
    expect(conv).toBeDefined();

    const markRead = await request(server())
      .patch(`/api/v1/messages/${conv!.id}/read`)
      .set('Authorization', `Bearer ${artisanToken}`);
    expect(markRead.status).toBe(200);
    expect(envelopeMessage(markRead)).toContain('marked as read');

    // Idempotent second call (two tabs) must not error.
    const again = await request(server())
      .patch(`/api/v1/messages/${conv!.id}/read`)
      .set('Authorization', `Bearer ${artisanToken}`);
    expect(again.status).toBe(200);

    const after = await request(server())
      .get('/api/v1/messages?page=1&limit=50')
      .set('Authorization', `Bearer ${artisanToken}`);
    const refreshed = envelope<MiniConversation[]>(after).find(
      (c) => c.id === conv!.id,
    );
    expect(refreshed?.unreadCount).toBe(0);

    // The artisan's own sent messages must still be unread from their side's
    // point of view — verified directly against the DB.
    const own = await messageRepo.find({
      where: { conversation: { id: conv!.id }, sender: { id: artisanUser.id } },
    });
    expect(own.length).toBeGreaterThan(0);
    // Customer never marked read in this test, so none of these flipped.
    expect(own.every((m) => m.isRead === false)).toBe(true);
  });

  // ── AD1 / AD2: admin dispute conversation ─────────────────────────────────

  async function makeDispute(
    customer: User,
    profile: ArtisanProfile,
    raisedBy: User,
  ): Promise<Dispute> {
    const booking = await bookingRepo.save(
      bookingRepo.create({
        customer,
        artisanProfile: profile,
        service,
        scheduledDate: '2026-08-01',
        startTime: '09:00:00',
        endTime: '10:00:00',
        status: BookingStatus.COMPLETED,
        currency: 'GHS',
      }),
    );
    createdBookingIds.push(booking.id);

    const dispute = await disputeRepo.save(
      disputeRepo.create({
        booking,
        bookingId: booking.id,
        raisedBy,
        raisedById: raisedBy.id,
        reason: `QA dispute ${uniq} for AD1/AD2 verification`,
        status: DisputeStatus.OPEN,
      }),
    );
    createdDisputeIds.push(dispute.id);
    return dispute;
  }

  it('AD1: an admin on an OPEN dispute sees the two parties conversation read-only', async () => {
    const dispute = await makeDispute(customer1, artisanProfile, customer1);

    const res = await request(server())
      .get(`/api/v1/admin/disputes/${dispute.id}/conversation`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const data = envelope<MiniDisputeConversation>(res);
    expect(data).not.toBeNull();
    expect(data.disputeId).toBe(dispute.id);
    expect(data.bookingId).toBe(dispute.bookingId);
    expect(data.customer.id).toBe(customer1.id);
    expect(data.customer.role).toBe('CUSTOMER');
    expect(data.artisan.id).toBe(artisanUser.id);
    expect(data.artisan.role).toBe('ARTISAN');
    expect(data.readOnly).toBe(true);
    expect(data.totalMessages).toBeGreaterThan(0);
    expect(data.messages.length).toBeGreaterThan(0);
    expect(data.messages.length).toBeLessThanOrEqual(200);
  });

  it('AD1: a dispute whose parties never messaged returns data:null with the "no conversation on file" message, not a 404', async () => {
    const dispute = await makeDispute(customer2, artisanProfile, customer2);
    // customer2 <-> artisan DID message earlier in this suite, so use a pair
    // that provably never has: customer2 <-> artisan2.
    const artisan2Profile = await profileRepo.findOne({
      where: { user: { id: artisan2User.id } },
    });
    const cleanDispute = await makeDispute(
      customer2,
      artisan2Profile!,
      customer2,
    );
    expect(dispute.id).toBeGreaterThan(0);

    const res = await request(server())
      .get(`/api/v1/admin/disputes/${cleanDispute.id}/conversation`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(envelope<null>(res)).toBeNull();
    expect(envelopeMessage(res)).toBe(
      'No conversation on file for this dispute.',
    );
  });

  it('AD2: a customer and an artisan both get 403 on the admin dispute-conversation route', async () => {
    const dispute = await makeDispute(customer1, artisanProfile, customer1);

    for (const token of [customer1Token, artisanToken, customer2Token]) {
      const res = await request(server())
        .get(`/api/v1/admin/disputes/${dispute.id}/conversation`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    }
  });

  it('AD2: no route accepts a conversation id or user pair — the participants are derived from the dispute only', async () => {
    // The documented boundary: there is no admin endpoint that takes a
    // conversation id or two user ids. Probe the shapes an attacker would try.
    const probes = [
      '/api/v1/admin/conversations',
      '/api/v1/admin/messages',
      `/api/v1/admin/conversations/${createdConversationIds[0]}`,
      `/api/v1/admin/messages/${createdConversationIds[0]}`,
    ];
    for (const p of probes) {
      const res = await request(server())
        .get(p)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(404);
    }
  });

  it('AD2: once the dispute is RESOLVED the conversation route returns 403 (documented strict reading of "open dispute")', async () => {
    const dispute = await makeDispute(customer1, artisanProfile, customer1);

    const open = await request(server())
      .get(`/api/v1/admin/disputes/${dispute.id}/conversation`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(open.status).toBe(200);

    const resolve = await request(server())
      .patch(`/api/v1/admin/disputes/${dispute.id}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ resolution: 'QA resolution: refunded in full.' });
    expect(resolve.status).toBe(200);

    const afterResolve = await request(server())
      .get(`/api/v1/admin/disputes/${dispute.id}/conversation`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(afterResolve.status).toBe(403);
  });

  // ── PD4: dispute outcome notifies both parties ────────────────────────────

  it('PD4: resolving a dispute notifies BOTH the raiser and the counterparty', async () => {
    const dispute = await makeDispute(customer1, artisanProfile, customer1);

    const beforeCust = await notificationsFor(customer1.id, 'DISPUTE_RESOLVED');
    const beforeArt = await notificationsFor(
      artisanUser.id,
      'DISPUTE_RESOLVED',
    );

    const res = await request(server())
      .patch(`/api/v1/admin/disputes/${dispute.id}/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ resolution: 'QA outcome: artisan to redo the work.' });
    expect(res.status).toBe(200);

    let afterCust = beforeCust;
    let afterArt = beforeArt;
    for (
      let i = 0;
      i < 20 &&
      (afterCust.length === beforeCust.length ||
        afterArt.length === beforeArt.length);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 250));
      afterCust = await notificationsFor(customer1.id, 'DISPUTE_RESOLVED');
      afterArt = await notificationsFor(artisanUser.id, 'DISPUTE_RESOLVED');
    }
    expect(afterCust.length).toBe(beforeCust.length + 1);
    expect(afterArt.length).toBe(beforeArt.length + 1);
    expect(afterCust[0].body).toContain('resolved');
    expect((afterCust[0].payload as { outcome?: string } | null)?.outcome).toBe(
      'RESOLVED',
    );
  });

  it('PD4: closing a dispute notifies BOTH parties', async () => {
    const dispute = await makeDispute(customer1, artisanProfile, artisanUser);

    const beforeCust = await notificationsFor(customer1.id, 'DISPUTE_CLOSED');
    const beforeArt = await notificationsFor(artisanUser.id, 'DISPUTE_CLOSED');

    const res = await request(server())
      .patch(`/api/v1/admin/disputes/${dispute.id}/close`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ adminNotes: 'QA close note.' });
    expect(res.status).toBe(200);

    let afterCust = beforeCust;
    let afterArt = beforeArt;
    for (
      let i = 0;
      i < 20 &&
      (afterCust.length === beforeCust.length ||
        afterArt.length === beforeArt.length);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 250));
      afterCust = await notificationsFor(customer1.id, 'DISPUTE_CLOSED');
      afterArt = await notificationsFor(artisanUser.id, 'DISPUTE_CLOSED');
    }
    expect(afterCust.length).toBe(beforeCust.length + 1);
    expect(afterArt.length).toBe(beforeArt.length + 1);
  });

  it('PR3: filing a dispute produces a DISPUTE_FILED notification for admin accounts', async () => {
    const booking = await bookingRepo.save(
      bookingRepo.create({
        customer: customer1,
        artisanProfile,
        service,
        scheduledDate: '2026-08-02',
        startTime: '11:00:00',
        endTime: '12:00:00',
        status: BookingStatus.COMPLETED,
        currency: 'GHS',
      }),
    );
    createdBookingIds.push(booking.id);

    const before = await notificationsFor(adminUser.id, 'DISPUTE_FILED');

    const res = await request(server())
      .post('/api/v1/disputes')
      .set('Authorization', `Bearer ${customer1Token}`)
      .send({
        bookingId: booking.id,
        reason: `QA raised dispute ${uniq} to check the admin queue notification`,
      });
    expect(res.status).toBe(201);
    const raised = envelope<{ id: number }>(res);
    createdDisputeIds.push(raised.id);

    let after = before;
    for (let i = 0; i < 20 && after.length === before.length; i++) {
      await new Promise((r) => setTimeout(r, 250));
      after = await notificationsFor(adminUser.id, 'DISPUTE_FILED');
    }
    expect(after.length).toBe(before.length + 1);
  });

  // ── Notifications feed / unread count ─────────────────────────────────────

  it('HB1: GET /notifications/unread-count reflects real unread notifications and drops after mark-all-read', async () => {
    const before = await request(server())
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${artisanToken}`);
    expect(before.status).toBe(200);
    const beforeCount = envelope<{ count: number }>(before).count;
    expect(beforeCount).toBeGreaterThan(0);

    const markAll = await request(server())
      .patch('/api/v1/notifications/read-all')
      .set('Authorization', `Bearer ${artisanToken}`);
    expect(markAll.status).toBe(200);

    const after = await request(server())
      .get('/api/v1/notifications/unread-count')
      .set('Authorization', `Bearer ${artisanToken}`);
    expect(envelope<{ count: number }>(after).count).toBe(0);
  });

  it('NR4: GET /notifications exposes meta.pagination so a "load more" beyond 50 is possible', async () => {
    const res = await request(server())
      .get('/api/v1/notifications?page=1&limit=5')
      .set('Authorization', `Bearer ${artisanToken}`);
    expect(res.status).toBe(200);
    expect(meta(res)?.pagination).toBeDefined();
    expect(meta(res)?.pagination?.limit).toBe(5);
  });

  it('PD5/PR3: an ADMIN caller gets the admin-shaped preferences body and can PATCH the five admin toggles', async () => {
    const get = await request(server())
      .get('/api/v1/notifications/preferences')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(get.status).toBe(200);
    const prefs = envelope<Record<string, unknown>>(get);
    for (const key of [
      'disputeFiled',
      'paymentTransferFailed',
      'verificationSubmitted',
      'reviewFlagged',
      'artisanRegistered',
    ]) {
      expect(Object.keys(prefs)).toContain(key);
    }

    const patch = await request(server())
      .patch('/api/v1/notifications/preferences')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ disputeFiled: false, reviewFlagged: false });
    expect(patch.status).toBe(200);
    expect(envelope<Record<string, unknown>>(patch).disputeFiled).toBe(false);

    // restore
    await request(server())
      .patch('/api/v1/notifications/preferences')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ disputeFiled: true, reviewFlagged: true });
  });

  it('PR1: the artisan preferences body really does include the four toggles the frontend used to drop', async () => {
    const res = await request(server())
      .get('/api/v1/notifications/preferences')
      .set('Authorization', `Bearer ${artisanToken}`);
    expect(res.status).toBe(200);
    const keys = Object.keys(envelope<Record<string, unknown>>(res));
    for (const key of [
      'verificationRejected',
      'bookingReceived',
      'bookingCancelled',
      'bookingCompletedArtisan',
    ]) {
      expect(keys).toContain(key);
    }
  });

  // ── RL1: rate limiting ────────────────────────────────────────────────────

  it('RL1: hitting the send limit returns the documented MESSAGE_RATE_LIMIT_EXCEEDED body, not a bare 429', async () => {
    // The limit is per authenticated sender. customer2 has barely sent
    // anything yet, so use it and burn through the window deliberately.
    let limited: request.Response | null = null;
    for (let i = 0; i < 60; i++) {
      const res = await send(customer2Token, {
        recipientId: artisanUser.id,
        content: `rate limit probe ${i}`,
      });
      if (res.status === 429) {
        limited = res;
        break;
      }
      expect(res.status).toBe(201);
    }

    expect(limited).not.toBeNull();
    const body = limited!.body as {
      errorCode?: string;
      message?: string;
      retryAfterSeconds?: number;
    };
    // NOTE ON SHAPE: this suite deliberately boots the app WITHOUT the
    // production global filters, so what lands here is the guard's raw thrown
    // body — `errorCode`, not `meta.error`. The shape a real browser receives
    // (the same values promoted into `meta` by AllExceptionsFilter) is pinned
    // separately in `rate-limit-error-contract.e2e-spec.ts`, which registers the
    // same filters `src/main.ts` does. Asserting `errorCode` here keeps this
    // test honest about the seam it actually exercises. (QA B1, re-verified
    // 2026-08-21 after commit 4085fbe.)
    expect(body.errorCode).toBe('MESSAGE_RATE_LIMIT_EXCEEDED');
    expect(body.message).toMatch(/sending messages too fast/i);
    expect(typeof body.retryAfterSeconds).toBe('number');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('RL1: the rate limit is scoped to the sender — a different user is not blocked by it', async () => {
    const res = await send(customer1Token, {
      recipientId: artisanUser.id,
      content: 'different sender, should still go through',
    });
    expect(res.status).toBe(201);
  });

  it('RL1: the limit applies only to POST /messages — reading is not throttled', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(server())
        .get('/api/v1/messages?page=1&limit=5')
        .set('Authorization', `Bearer ${customer2Token}`);
      expect(res.status).toBe(200);
    }
  });

  // ── EC2: email anti-flood (is email-on-message even built?) ───────────────

  it('EC2: records whether a message-received email listener exists at all in this build', () => {
    // api-contract.md section 8 states EC1-EC4 (including message-received
    // email) were NOT built this round. This asserts the documented state so
    // the report can be specific rather than speculative: there is no
    // MESSAGE_RECEIVED mail handler, therefore no per-message email flood is
    // possible yet — and no anti-flood debounce exists to verify either.
    const methods = Object.getOwnPropertyNames(
      MailService.prototype as unknown as object,
    );
    expect(methods.filter((m) => /message/i.test(m))).toEqual([]);
  });
});
