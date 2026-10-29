import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { In, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { NotificationPreferences } from '../src/notifications/entities/notification-preferences.entity';
import { Notification } from '../src/notifications/entities/notification.entity';
import { UserTokenService } from '@users/token.service';
import { Role } from '@common/types/enums';
import { APP_EVENTS } from '@common/events/app.events';

/**
 * QA verification (messaging-notifications — PD1/PD2/PD3/PD4/PD5 + money copy).
 *
 * The Payments and Disputes modules emit the new notification events at their
 * real state transitions (verified by reading `PaymentsService.onChargeSuccess`
 * / `onTransferSuccess` / `onTransferFailed` / `adminRefund`), but those
 * transitions are driven by signed Paystack webhooks that cannot be forged in a
 * test without reading the webhook secret out of the environment — which QA
 * does not do. So this spec verifies the half that owns the *user-visible*
 * outcome: the notification listeners.
 *
 * For each new event it asserts, against the real database, that:
 *   - a notification row is persisted for the correct recipient;
 *   - it carries the documented `type` and `payload` keys (api-contract.md s5);
 *   - every monetary amount in the body renders as `GH₵ 1,234.56` — never a
 *     bare number, never `$` (feature requirement "Money / currency");
 *   - PD5's preference gating actually suppresses a muted type;
 *   - PD4 dispute outcomes reach BOTH parties and are deliberately ungated.
 *
 * Run: npm run test:e2e -- payment-dispute-notifications
 *
 * QA test code only — no application/feature code is touched. Fixtures are
 * removed in `afterAll`.
 */
jest.setTimeout(120000);

interface Envelope<T> {
  data: T;
}
function envelope<T>(res: request.Response): T {
  return (res.body as Envelope<T>).data;
}

const MONEY_OK = /GH₵\s[\d,]+\.\d{2}/;
const BARE_DOLLAR = /\$\s?\d/;

describe('Payments & Disputes notification content (e2e)', () => {
  let app: INestApplication<App>;
  let events: EventEmitter2;

  let userRepo: Repository<User>;
  let profileRepo: Repository<ArtisanProfile>;
  let prefsRepo: Repository<NotificationPreferences>;
  let notificationRepo: Repository<Notification>;
  let tokenService: UserTokenService;

  let customer: User;
  let customerToken: string;
  let artisanUser: User;
  let artisanProfile: ArtisanProfile;
  let adminUser: User;

  const uniq = Date.now();
  const server = () => app.getHttpServer();

  async function waitForNotification(
    userId: number,
    type: string,
    baseline: number,
  ): Promise<Notification[]> {
    let rows = await notificationRepo.find({
      where: { user: { id: userId }, type },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    for (let i = 0; i < 24 && rows.length === baseline; i++) {
      await new Promise((r) => setTimeout(r, 250));
      rows = await notificationRepo.find({
        where: { user: { id: userId }, type },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
    }
    return rows;
  }

  async function countNotifications(
    userId: number,
    type: string,
  ): Promise<number> {
    return notificationRepo.count({ where: { user: { id: userId }, type } });
  }

  async function makeUser(
    label: string,
    role: Role,
  ): Promise<{ user: User; token: string }> {
    const user = await userRepo.save(
      userRepo.create({
        email: `qa-pdn-${label}-${uniq}@test.jinva.local`,
        password: null,
        firstname: 'QaPdn',
        lastname: label,
        role,
        accountVerified: true,
        isBanned: false,
      }),
    );
    const token = (await tokenService.createJWTTokens(user)).access_token;
    return { user, token };
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

    events = moduleFixture.get(EventEmitter2);
    userRepo = moduleFixture.get(getRepositoryToken(User));
    profileRepo = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    prefsRepo = moduleFixture.get(getRepositoryToken(NotificationPreferences));
    notificationRepo = moduleFixture.get(getRepositoryToken(Notification));
    tokenService = moduleFixture.get(UserTokenService);

    ({ user: customer, token: customerToken } = await makeUser(
      'Customer',
      Role.CUSTOMER,
    ));
    ({ user: artisanUser } = await makeUser('Artisan', Role.ARTISAN));
    artisanProfile = await profileRepo.save(
      profileRepo.create({
        user: artisanUser,
        currency: 'GHS',
        isVerified: true,
        isProfileComplete: true,
      }),
    );
    ({ user: adminUser } = await makeUser('Admin', Role.ADMIN));
  });

  afterAll(async () => {
    const ignore = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* ignore */
      }
    };
    const ids = [customer.id, artisanUser.id, adminUser.id];
    await ignore(() =>
      notificationRepo
        .createQueryBuilder()
        .delete()
        .where('user_id IN (:...ids)', { ids })
        .execute(),
    );
    await ignore(() =>
      prefsRepo
        .createQueryBuilder()
        .delete()
        .where('user_id IN (:...ids)', { ids })
        .execute(),
    );
    await ignore(() => profileRepo.delete({ id: artisanProfile.id }));
    await ignore(() => userRepo.delete({ id: In(ids) }));
    await app.close();
  });

  // ── PD1 ───────────────────────────────────────────────────────────────────

  it('PD1: PAYMENT_RECEIPT reaches the customer with a GH₵-formatted amount and jobId/reference payload', async () => {
    const baseline = await countNotifications(customer.id, 'PAYMENT_RECEIPT');
    events.emit(APP_EVENTS.PAYMENT_RECEIPT, {
      customerId: customer.id,
      jobId: 987654,
      jobTitle: 'QA Kitchen Sink Repair',
      amount: 1250,
      reference: `qa-ref-${uniq}`,
    });

    const rows = await waitForNotification(
      customer.id,
      'PAYMENT_RECEIPT',
      baseline,
    );
    expect(rows.length).toBe(baseline + 1);
    const n = rows[0];
    expect(n.title).toBe('Payment Received');
    expect(n.body).toMatch(MONEY_OK);
    expect(n.body).toContain('GH₵ 1,250.00');
    expect(n.body).not.toMatch(BARE_DOLLAR);
    expect(n.body).toContain('QA Kitchen Sink Repair');
    const payload = n.payload as { jobId?: number; reference?: string } | null;
    expect(payload?.jobId).toBe(987654);
    expect(payload?.reference).toBe(`qa-ref-${uniq}`);
  });

  // ── PD2 ───────────────────────────────────────────────────────────────────

  it('PD2: PAYMENT_SECURED reaches the artisan with a GH₵-formatted amount', async () => {
    const baseline = await countNotifications(
      artisanUser.id,
      'PAYMENT_SECURED',
    );
    events.emit(APP_EVENTS.PAYMENT_SECURED, {
      artisanUserId: artisanUser.id,
      jobId: 987654,
      jobTitle: 'QA Kitchen Sink Repair',
      artisanAmount: 1062.5,
    });
    const rows = await waitForNotification(
      artisanUser.id,
      'PAYMENT_SECURED',
      baseline,
    );
    expect(rows.length).toBe(baseline + 1);
    expect(rows[0].title).toBe('Payment Secured');
    expect(rows[0].body).toContain('GH₵ 1,062.50');
    expect(rows[0].body).not.toMatch(BARE_DOLLAR);
  });

  it('PD2: PAYOUT_RELEASED is a SEPARATE notification from job completion and renders GH₵', async () => {
    const baseline = await countNotifications(
      artisanUser.id,
      'PAYOUT_RELEASED',
    );
    events.emit(APP_EVENTS.PAYOUT_RELEASED, {
      artisanUserId: artisanUser.id,
      jobId: 987654,
      jobTitle: 'QA Kitchen Sink Repair',
      artisanAmount: 1062.5,
    });
    const rows = await waitForNotification(
      artisanUser.id,
      'PAYOUT_RELEASED',
      baseline,
    );
    expect(rows.length).toBe(baseline + 1);
    expect(rows[0].title).toBe('Payout Released');
    expect(rows[0].body).toContain('GH₵ 1,062.50');
    expect(rows[0].body).toContain('released');
  });

  it('PD2: JOB_COMPLETED no longer claims the payment was already released', async () => {
    const baseline = await countNotifications(artisanUser.id, 'JOB_COMPLETED');
    events.emit(APP_EVENTS.JOB_COMPLETED, {
      artisanId: artisanUser.id,
      customerId: customer.id,
      jobId: 987654,
      jobTitle: 'QA Kitchen Sink Repair',
    });
    const rows = await waitForNotification(
      artisanUser.id,
      'JOB_COMPLETED',
      baseline,
    );
    expect(rows.length).toBe(baseline + 1);
    expect(rows[0].body).not.toContain('has been released');
    expect(rows[0].body.toLowerCase()).toContain('being processed');
  });

  // ── PD3 ───────────────────────────────────────────────────────────────────

  it('PD3: PAYMENT_REFUNDED reaches the customer, distinguishes partial vs full, and renders GH₵', async () => {
    const baseFull = await countNotifications(customer.id, 'PAYMENT_REFUNDED');
    events.emit(APP_EVENTS.PAYMENT_REFUNDED, {
      customerId: customer.id,
      jobId: 987654,
      jobTitle: 'QA Kitchen Sink Repair',
      refundedAmount: 1250,
      fullyRefunded: true,
    });
    let rows = await waitForNotification(
      customer.id,
      'PAYMENT_REFUNDED',
      baseFull,
    );
    expect(rows.length).toBe(baseFull + 1);
    expect(rows[0].title).toBe('Refund Issued');
    expect(rows[0].body).toContain('GH₵ 1,250.00');
    expect(rows[0].body).not.toMatch(BARE_DOLLAR);

    const basePartial = rows.length;
    events.emit(APP_EVENTS.PAYMENT_REFUNDED, {
      customerId: customer.id,
      jobId: 987654,
      jobTitle: 'QA Kitchen Sink Repair',
      refundedAmount: 300.75,
      fullyRefunded: false,
    });
    rows = await waitForNotification(
      customer.id,
      'PAYMENT_REFUNDED',
      basePartial,
    );
    expect(rows[0].title).toBe('Partial Refund');
    expect(rows[0].body).toContain('GH₵ 300.75');
    expect((rows[0].payload as { fullyRefunded?: boolean }).fullyRefunded).toBe(
      false,
    );
  });

  // ── PR3 admin queue ───────────────────────────────────────────────────────

  it('PR3: PAYMENT_TRANSFER_FAILED goes to admins (not the artisan) and renders GH₵', async () => {
    const adminBase = await countNotifications(
      adminUser.id,
      'PAYMENT_TRANSFER_FAILED',
    );
    const artisanBase = await countNotifications(
      artisanUser.id,
      'PAYMENT_TRANSFER_FAILED',
    );
    events.emit(APP_EVENTS.PAYMENT_TRANSFER_FAILED, {
      paymentId: 4242,
      jobId: 987654,
      jobTitle: 'QA Kitchen Sink Repair',
      artisanName: 'QaPdn Artisan',
      artisanAmount: 1062.5,
      reason: 'Recipient account invalid',
    });
    const rows = await waitForNotification(
      adminUser.id,
      'PAYMENT_TRANSFER_FAILED',
      adminBase,
    );
    expect(rows.length).toBe(adminBase + 1);
    expect(rows[0].body).toContain('GH₵ 1,062.50');
    expect(
      await countNotifications(artisanUser.id, 'PAYMENT_TRANSFER_FAILED'),
    ).toBe(artisanBase);
  });

  // ── PD4 ───────────────────────────────────────────────────────────────────

  it('PD4: DISPUTE_RESOLVED reaches BOTH parties and is deliberately ungated (no dispute toggle exists)', async () => {
    const custBase = await countNotifications(customer.id, 'DISPUTE_RESOLVED');
    const artBase = await countNotifications(
      artisanUser.id,
      'DISPUTE_RESOLVED',
    );

    events.emit(APP_EVENTS.DISPUTE_RESOLVED, {
      disputeId: 555,
      bookingId: 666,
      raisedByUserId: customer.id,
      counterpartyUserId: artisanUser.id,
      outcome: 'RESOLVED',
      resolution: 'QA outcome: partial refund agreed.',
    });

    const cust = await waitForNotification(
      customer.id,
      'DISPUTE_RESOLVED',
      custBase,
    );
    const art = await waitForNotification(
      artisanUser.id,
      'DISPUTE_RESOLVED',
      artBase,
    );
    expect(cust.length).toBe(custBase + 1);
    expect(art.length).toBe(artBase + 1);
    expect(cust[0].body).toContain('QA outcome: partial refund agreed.');
    const payload = cust[0].payload as {
      disputeId?: number;
      bookingId?: number;
      outcome?: string;
    };
    expect(payload.disputeId).toBe(555);
    expect(payload.bookingId).toBe(666);
    expect(payload.outcome).toBe('RESOLVED');
  });

  it('PD4: a malformed payload where both ids are the same person produces ONE row, not two', async () => {
    const base = await countNotifications(customer.id, 'DISPUTE_CLOSED');
    events.emit(APP_EVENTS.DISPUTE_CLOSED, {
      disputeId: 777,
      bookingId: 888,
      raisedByUserId: customer.id,
      counterpartyUserId: customer.id,
      outcome: 'CLOSED',
    });
    const rows = await waitForNotification(customer.id, 'DISPUTE_CLOSED', base);
    expect(rows.length).toBe(base + 1);
  });

  // ── PD5: preference gating ────────────────────────────────────────────────

  it('PD5: turning off paymentReceipts suppresses PAYMENT_RECEIPT (the toggle is finally real)', async () => {
    const off = await request(server())
      .patch('/api/v1/notifications/preferences')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ paymentReceipts: false });
    expect(off.status).toBe(200);
    expect(envelope<{ paymentReceipts: boolean }>(off).paymentReceipts).toBe(
      false,
    );

    const base = await countNotifications(customer.id, 'PAYMENT_RECEIPT');
    events.emit(APP_EVENTS.PAYMENT_RECEIPT, {
      customerId: customer.id,
      jobId: 111,
      jobTitle: 'QA Suppressed Job',
      amount: 500,
      reference: `qa-ref-suppressed-${uniq}`,
    });
    // Give the listener a genuine chance to fire before asserting it did not.
    await new Promise((r) => setTimeout(r, 2500));
    expect(await countNotifications(customer.id, 'PAYMENT_RECEIPT')).toBe(base);

    // Restore, and confirm delivery resumes.
    const on = await request(server())
      .patch('/api/v1/notifications/preferences')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ paymentReceipts: true });
    expect(on.status).toBe(200);

    events.emit(APP_EVENTS.PAYMENT_RECEIPT, {
      customerId: customer.id,
      jobId: 112,
      jobTitle: 'QA Restored Job',
      amount: 500,
      reference: `qa-ref-restored-${uniq}`,
    });
    const rows = await waitForNotification(
      customer.id,
      'PAYMENT_RECEIPT',
      base,
    );
    expect(rows.length).toBe(base + 1);
  });

  it('PD5: the customer preferences body has NO dispute toggle (api-contract.md s5 says do not add one)', async () => {
    const res = await request(server())
      .get('/api/v1/notifications/preferences')
      .set('Authorization', `Bearer ${customerToken}`);
    expect(res.status).toBe(200);
    const keys = Object.keys(envelope<Record<string, unknown>>(res));
    expect(keys.filter((k) => /dispute/i.test(k))).toEqual([]);
  });

  it('all-channels-off suppresses in-app too (pre-existing documented quirk, flagged not changed)', async () => {
    await request(server())
      .patch('/api/v1/notifications/preferences')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ emailEnabled: false, smsEnabled: false, pushEnabled: false });

    const base = await countNotifications(customer.id, 'PAYMENT_REFUNDED');
    events.emit(APP_EVENTS.PAYMENT_REFUNDED, {
      customerId: customer.id,
      jobId: 113,
      jobTitle: 'QA All Channels Off',
      refundedAmount: 42,
      fullyRefunded: true,
    });
    await new Promise((r) => setTimeout(r, 2500));
    const after = await countNotifications(customer.id, 'PAYMENT_REFUNDED');

    // Restore before asserting so a failure can't leave the fixture muted.
    await request(server())
      .patch('/api/v1/notifications/preferences')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ emailEnabled: true, smsEnabled: false, pushEnabled: true });

    expect(after).toBe(base);
  });

  // ── Money copy sweep ──────────────────────────────────────────────────────

  it('no notification body produced by this feature contains a bare $ amount or an unlabelled figure', async () => {
    const rows = await notificationRepo
      .createQueryBuilder('n')
      .where('n.user_id IN (:...ids)', {
        ids: [customer.id, artisanUser.id, adminUser.id],
      })
      .getMany();
    expect(rows.length).toBeGreaterThan(0);
    for (const n of rows) {
      expect(n.body).not.toMatch(BARE_DOLLAR);
      expect(n.body).not.toMatch(/USD/);
      // Any row that mentions money at all must label it GH₵.
      if (/\d[\d,]*\.\d{2}/.test(n.body)) {
        expect(n.body).toMatch(MONEY_OK);
      }
    }
  });
});
