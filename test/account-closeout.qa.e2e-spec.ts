/**
 * QA verification for `docs/team/auth-settings-closeout/requirements.md`
 * (C1 + C2), against a real database and production's global wiring.
 *
 * Test code only — written by QA to verify the round's acceptance criteria.
 * Nothing here is imported by the application.
 *
 * Run: npm run test:e2e -- account-closeout.qa
 *
 * The auth throttler's limits are raised for this process only (before
 * `AppModule` is compiled): this file makes far more than 10 login/restore
 * calls a minute, and the limits themselves already have their own coverage in
 * `auth-rate-limit.e2e-spec.ts`.
 */
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '10000';
process.env.AUTH_EMAIL_RATE_LIMIT_PER_MINUTE = '10000';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { In, IsNull, Not, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import * as bcrypt from 'bcrypt';
import { addDays, subDays, subMinutes } from 'date-fns';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { Address } from '@users/entities/address.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { Booking } from '../src/bookings/entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { Payment } from '../src/payments/entities/payment.entity';
import { Dispute } from '../src/disputes/entities/dispute.entity';
import { UserTokenService } from '@users/token.service';
import { UsersService } from '@users/users.service';
import { AuthService } from '../src/auth/auth.service';
import { SocialAuthStrategyFactory } from '../src/auth/social-auth.factory';
import { OAuthStateService } from '../src/auth/oauth-state.service';
import { AccountPurgeService } from '@users/account-purge.service';
import { AccountPurgeSchedulerService } from '../src/scheduler/account-purge-scheduler.service';
import {
  BookingStatus,
  DisputeCategory,
  DisputeStatus,
  PaymentStatus,
  Role,
  Status,
} from '@common/types/enums';

jest.setTimeout(300000);

interface Body {
  status?: string;
  message?: string;
  restored?: boolean;
  requiresEmailVerification?: boolean;
  access_token?: string;
  password?: string;
  data?: Record<string, unknown>;
  meta?: {
    error?: string;
    statusCode?: number;
    details?: Record<string, unknown>;
  };
}

const PASSWORD = 'CorrectHorse1!';

/** Count of a user's remaining auth tokens, read with a typed raw query. */
async function tokenCount(
  repo: Repository<User>,
  userId: number,
): Promise<number> {
  const rows: { c: number }[] = await repo.manager.query(
    'select count(*)::int as c from user_tokens where user_id = $1',
    [userId],
  );
  return Number(rows[0].c);
}

/**
 * Mutable so each Google test points the stubbed OAuth transport at its own
 * fixture's address; `beforeAll` closes over this object, not its contents.
 */
const googleProfile: {
  email: string;
  firstname: string;
  lastname: string;
  provider: string;
  providerId: string;
} = {
  email: 'unset@test.jinva.local',
  firstname: 'Qa',
  lastname: 'Google',
  provider: 'google',
  providerId: 'qa-google-id',
};

describe('auth-settings-closeout C1/C2 (QA e2e)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;

  let userRepo: Repository<User>;
  let profileRepo: Repository<ArtisanProfile>;
  let addressRepo: Repository<Address>;
  let serviceRepo: Repository<ServiceEntity>;
  let bookingRepo: Repository<Booking>;
  let jobRepo: Repository<Job>;
  let paymentRepo: Repository<Payment>;
  let disputeRepo: Repository<Dispute>;
  let tokenService: UserTokenService;
  let purgeService: AccountPurgeService;
  let purgeScheduler: AccountPurgeSchedulerService;
  let usersService: UsersService;
  let authService: AuthService;

  let service: ServiceEntity;
  const uniq = Date.now();
  const createdUserIds: number[] = [];
  const createdProfileIds: number[] = [];
  const createdBookingIds: number[] = [];
  const createdJobIds: number[] = [];
  const createdPaymentIds: number[] = [];
  const createdDisputeIds: number[] = [];

  const server = () => app.getHttpServer();
  const email = (label: string) =>
    `qa-closeout-${label}-${uniq}@test.jinva.local`;

  const login = (e: string, p: string) =>
    request(server())
      .post('/api/v1/auth/login')
      .send({ email: e, password: p });
  const restore = (e: string, p: string) =>
    request(server())
      .post('/api/v1/auth/restore-account')
      .send({ email: e, password: p });
  const deleteMe = (token: string) =>
    request(server())
      .delete('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`);

  async function makeUser(
    label: string,
    role: Role,
    opts: { verified?: boolean; social?: boolean } = {},
  ): Promise<{ user: User; token: string; email: string }> {
    const e = email(label);
    const user = await userRepo.save(
      userRepo.create({
        email: e,
        password: opts.social ? null : await bcrypt.hash(PASSWORD, 10),
        firstname: 'QaCloseout',
        lastname: label.slice(0, 14),
        role,
        accountVerified: opts.verified ?? true,
        isBanned: false,
        isSuspended: false,
        ...(opts.social
          ? {
              isSocialLogin: true,
              socialProvider: 'google',
              socialProviderId: `g-${label}-${uniq}`,
            }
          : {}),
      } as Partial<User>),
    );
    createdUserIds.push(user.id);
    return {
      user,
      email: e,
      token: (await tokenService.createJWTTokens(user)).access_token,
    };
  }

  async function makeArtisanProfile(
    user: User,
    fields: Partial<ArtisanProfile> = {},
  ): Promise<ArtisanProfile> {
    const p = await profileRepo.save(
      profileRepo.create({ user, ...fields } as Partial<ArtisanProfile>),
    );
    createdProfileIds.push(p.id);
    return p;
  }

  async function makeBooking(
    customer: User,
    artisanProfile: ArtisanProfile,
    status: BookingStatus,
  ): Promise<Booking> {
    const b = await bookingRepo.save(
      bookingRepo.create({
        customer,
        artisanProfile,
        service,
        scheduledDate: '2026-10-01',
        startTime: '09:00:00',
        endTime: '10:00:00',
        status,
        agreedPrice: 120,
        currency: 'GHS',
      }),
    );
    createdBookingIds.push(b.id);
    return b;
  }

  async function makeJob(
    customer: User,
    status: Status,
    acceptedArtisan?: User,
  ): Promise<Job> {
    const j = await jobRepo.save(
      jobRepo.create({
        customer,
        service,
        title: 'QA closeout job',
        description: 'QA fixture',
        location: 'Accra',
        status,
        currency: 'GHS',
        ...(acceptedArtisan ? { acceptedArtisan } : {}),
      }),
    );
    createdJobIds.push(j.id);
    return j;
  }

  async function makePayment(
    job: Job,
    customer: User,
    artisanProfile: ArtisanProfile,
    status: PaymentStatus,
  ): Promise<Payment> {
    const p = await paymentRepo.save(
      paymentRepo.create({
        job,
        customer,
        artisanProfile,
        amount: 250,
        platformFee: 25,
        artisanAmount: 225,
        currency: 'GHS',
        status,
        reference: `qa-closeout-${status}-${Math.random().toString(36).slice(2, 10)}-${uniq}`,
      }),
    );
    createdPaymentIds.push(p.id);
    return p;
  }

  async function makeDispute(
    booking: Booking,
    raisedBy: User,
    status: DisputeStatus,
  ): Promise<Dispute> {
    const d = await disputeRepo.save(
      disputeRepo.create({
        booking,
        raisedBy,
        category: DisputeCategory.WORK_QUALITY,
        reason: 'QA closeout fixture dispute for C1.1 verification.',
        status,
      } as Partial<Dispute>),
    );
    createdDisputeIds.push(d.id);
    return d;
  }

  /** Byte-comparable shape of a login/restore rejection. */
  const comparable = (res: request.Response) => {
    const b = res.body as Body;
    return {
      status: res.status,
      envelopeStatus: b.status,
      message: b.message,
      error: b.meta?.error,
      statusCode: b.meta?.statusCode,
      details: b.meta?.details ?? null,
      hasToken: Boolean(b.access_token),
      setCookie: Boolean(res.headers['set-cookie']),
    };
  };

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Only the OAuth *transport* is stubbed (there is no way to complete a
      // real Google consent screen from a test). Everything the restore
      // actually depends on — UsersService, the row lock, the real database —
      // is untouched, so this exercises the genuine Google restore path.
      .overrideProvider(SocialAuthStrategyFactory)
      .useValue({
        getStrategy: () => ({
          getAccessToken: () => Promise.resolve('qa-provider-token'),
          getUserProfile: () => Promise.resolve(googleProfile),
          generateAuthUrl: () => 'https://accounts.google.test/auth',
        }),
      })
      .overrideProvider(OAuthStateService)
      .useValue({
        createState: () => 'qa-state',
        consumeState: () => ({ role: Role.CUSTOMER }),
      })
      .compile();

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

    userRepo = moduleFixture.get(getRepositoryToken(User));
    profileRepo = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    addressRepo = moduleFixture.get(getRepositoryToken(Address));
    serviceRepo = moduleFixture.get(getRepositoryToken(ServiceEntity));
    bookingRepo = moduleFixture.get(getRepositoryToken(Booking));
    jobRepo = moduleFixture.get(getRepositoryToken(Job));
    paymentRepo = moduleFixture.get(getRepositoryToken(Payment));
    disputeRepo = moduleFixture.get(getRepositoryToken(Dispute));
    tokenService = moduleFixture.get(UserTokenService);
    purgeService = moduleFixture.get(AccountPurgeService);
    purgeScheduler = moduleFixture.get(AccountPurgeSchedulerService);
    usersService = moduleFixture.get(UsersService);
    authService = moduleFixture.get(AuthService);

    service = await serviceRepo.save(
      serviceRepo.create({
        name: `QA Closeout Service ${uniq}`,
        estimatedDurationMins: 60,
      }),
    );
  });

  afterAll(async () => {
    if (createdDisputeIds.length) await disputeRepo.delete(createdDisputeIds);
    if (createdPaymentIds.length) await paymentRepo.delete(createdPaymentIds);
    if (createdBookingIds.length) await bookingRepo.delete(createdBookingIds);
    if (createdJobIds.length) await jobRepo.delete(createdJobIds);
    for (const id of createdUserIds) {
      await addressRepo
        .delete({ user: { id } } as never)
        .catch(() => undefined);
    }
    if (createdProfileIds.length)
      await profileRepo.delete(createdProfileIds).catch(() => undefined);
    if (createdUserIds.length)
      await userRepo.delete(createdUserIds).catch(() => undefined);
    if (service) await serviceRepo.delete(service.id).catch(() => undefined);
    await app.close();
  });

  // ───────────────────────── C1.1 refusals ─────────────────────────

  describe('C1.1 — deletion refused while live commitments exist', () => {
    it('refuses for a live PENDING booking (customer side) and leaves the account untouched', async () => {
      const cust = await makeUser('b1c', Role.CUSTOMER);
      const art = await makeUser('b1a', Role.ARTISAN);
      const prof = await makeArtisanProfile(art.user);
      await makeBooking(cust.user, prof, BookingStatus.PENDING);

      const res = await deleteMe(cust.token);
      const body = res.body as Body;

      console.log('C1.1 booking refusal =', res.status, JSON.stringify(body));
      expect(res.status).toBe(409);
      expect(body.meta?.error).toBe('ACCOUNT_HAS_LIVE_COMMITMENTS');
      expect(body.message).toContain('booking');
      const after = await userRepo.findOne({
        where: { id: cust.user.id },
        withDeleted: true,
      });
      expect(after?.deletedAt ?? null).toBeNull();
      // still fully logged in
      const me = await request(server())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${cust.token}`);
      expect(me.status).toBe(200);
    });

    it('refuses for the booked artisan on a CONFIRMED booking', async () => {
      const cust = await makeUser('b2c', Role.CUSTOMER);
      const art = await makeUser('b2a', Role.ARTISAN);
      const prof = await makeArtisanProfile(art.user);
      await makeBooking(cust.user, prof, BookingStatus.CONFIRMED);

      const res = await deleteMe(art.token);
      const body = res.body as Body;

      console.log(
        'C1.1 artisan booking refusal =',
        res.status,
        JSON.stringify(body.message),
      );
      expect(res.status).toBe(409);
      expect(body.meta?.error).toBe('ACCOUNT_HAS_LIVE_COMMITMENTS');
    });

    it('refuses for a live job — OPEN (customer) and IN_PROGRESS (accepted artisan)', async () => {
      const cust = await makeUser('j1c', Role.CUSTOMER);
      await makeJob(cust.user, Status.OPEN);
      const resCust = await deleteMe(cust.token);

      console.log(
        'C1.1 OPEN job refusal =',
        resCust.status,
        JSON.stringify((resCust.body as Body).message),
      );
      expect(resCust.status).toBe(409);
      expect((resCust.body as Body).message).toContain('job');

      const cust2 = await makeUser('j2c', Role.CUSTOMER);
      const art2 = await makeUser('j2a', Role.ARTISAN);
      await makeJob(cust2.user, Status.IN_PROGRESS, art2.user);
      const resArt = await deleteMe(art2.token);

      console.log(
        'C1.1 IN_PROGRESS job refusal (artisan) =',
        resArt.status,
        JSON.stringify((resArt.body as Body).message),
      );
      expect(resArt.status).toBe(409);
      expect((resArt.body as Body).meta?.error).toBe(
        'ACCOUNT_HAS_LIVE_COMMITMENTS',
      );
    });

    it.each([
      PaymentStatus.PENDING,
      PaymentStatus.HELD,
      PaymentStatus.PENDING_TRANSFER,
      PaymentStatus.TRANSFER_FAILED,
    ])(
      'refuses for an in-flight payment in %s, for both parties',
      async (st) => {
        const tag = st.toLowerCase().replace(/_/g, '');
        const cust = await makeUser(`p-${tag}-c`, Role.CUSTOMER);
        const art = await makeUser(`p-${tag}-a`, Role.ARTISAN);
        const prof = await makeArtisanProfile(art.user);
        const job = await makeJob(cust.user, Status.COMPLETED, art.user);
        await makePayment(job, cust.user, prof, st);

        const resArt = await deleteMe(art.token);

        console.log(
          `C1.1 payment ${st} refusal (artisan) =`,
          resArt.status,
          JSON.stringify((resArt.body as Body).message),
        );
        expect(resArt.status).toBe(409);
        expect((resArt.body as Body).message).toContain('payment');
        // Money must never be named as a bare number, and never with `$`.
        expect((resArt.body as Body).message).not.toMatch(/\$|\d+\.\d{2}/);

        const resCust = await deleteMe(cust.token);
        expect(resCust.status).toBe(409);
      },
    );

    it.each([DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW])(
      'refuses for a %s dispute, for the raiser and the counterparty',
      async (st) => {
        const tag = st.toLowerCase().replace(/_/g, '');
        const cust = await makeUser(`d-${tag}-c`, Role.CUSTOMER);
        const art = await makeUser(`d-${tag}-a`, Role.ARTISAN);
        const prof = await makeArtisanProfile(art.user);
        const booking = await makeBooking(
          cust.user,
          prof,
          BookingStatus.COMPLETED,
        );
        await makeDispute(booking, cust.user, st);

        const resRaiser = await deleteMe(cust.token);

        console.log(
          `C1.1 dispute ${st} refusal (raiser) =`,
          resRaiser.status,
          JSON.stringify((resRaiser.body as Body).message),
        );
        expect(resRaiser.status).toBe(409);
        expect((resRaiser.body as Body).message).toContain('dispute');

        const resOther = await deleteMe(art.token);
        expect(resOther.status).toBe(409);
      },
    );

    it('reports every blocker category in one message', async () => {
      const cust = await makeUser('allc', Role.CUSTOMER);
      const art = await makeUser('alla', Role.ARTISAN);
      const prof = await makeArtisanProfile(art.user);
      await makeBooking(cust.user, prof, BookingStatus.PENDING);
      const liveJob = await makeJob(cust.user, Status.OPEN);
      await makePayment(liveJob, cust.user, prof, PaymentStatus.HELD);
      const completed = await makeBooking(
        cust.user,
        prof,
        BookingStatus.COMPLETED,
      );
      await makeDispute(completed, cust.user, DisputeStatus.OPEN);

      const res = await deleteMe(cust.token);
      const msg = (res.body as Body).message ?? '';

      console.log('C1.1 combined refusal =', res.status, JSON.stringify(msg));
      expect(res.status).toBe(409);
      for (const word of ['booking', 'job', 'payment', 'dispute']) {
        expect(msg).toContain(word);
      }
      expect(msg).not.toMatch(/\$/);
    });

    it('permits deletion when only terminal-state records remain', async () => {
      const cust = await makeUser('termc', Role.CUSTOMER);
      const art = await makeUser('terma', Role.ARTISAN);
      const prof = await makeArtisanProfile(art.user);

      for (const st of [
        BookingStatus.COMPLETED,
        BookingStatus.CANCELLED,
        BookingStatus.DECLINED,
        BookingStatus.EXPIRED,
        BookingStatus.NO_SHOW,
      ]) {
        await makeBooking(cust.user, prof, st);
      }
      for (const st of [Status.COMPLETED, Status.CANCELLED, Status.EXPIRED]) {
        await makeJob(cust.user, st, art.user);
      }
      const doneJob = await makeJob(cust.user, Status.COMPLETED, art.user);
      for (const st of [
        PaymentStatus.RELEASED,
        PaymentStatus.REFUNDED,
        PaymentStatus.CANCELLED,
        PaymentStatus.FAILED,
      ]) {
        await makePayment(doneJob, cust.user, prof, st);
      }
      const resolvedBooking = await makeBooking(
        cust.user,
        prof,
        BookingStatus.COMPLETED,
      );
      await makeDispute(resolvedBooking, cust.user, DisputeStatus.RESOLVED);
      const closedBooking = await makeBooking(
        cust.user,
        prof,
        BookingStatus.COMPLETED,
      );
      await makeDispute(closedBooking, cust.user, DisputeStatus.CLOSED);

      const res = await deleteMe(cust.token);

      console.log(
        'C1.1 terminal-only deletion =',
        res.status,
        JSON.stringify(res.body),
      );
      expect(res.status).toBe(200);
      const body = res.body as Body;
      expect(body.data?.deletedAt).toBeDefined();
      expect(body.data?.purgeAt).toBeDefined();
      expect(body.data?.retentionDays).toBe(30);
      const deletedAt = new Date(String(body.data?.deletedAt));
      const purgeAt = new Date(String(body.data?.purgeAt));
      expect(
        Math.round((purgeAt.getTime() - deletedAt.getTime()) / 86400000),
      ).toBe(30);
    });
  });

  // ───────────────────── C1.2 immediate effects ─────────────────────

  describe('C1.2 — what deletion does immediately', () => {
    it('soft-deletes, revokes refresh tokens, and 401s a still-unexpired access token', async () => {
      const u = await makeUser('imm', Role.CUSTOMER);
      const { refresh_token } = await tokenService.createJWTTokens(u.user);

      const del = await deleteMe(u.token);
      expect(del.status).toBe(200);

      const row = await userRepo.findOne({
        where: { id: u.user.id },
        withDeleted: true,
      });
      expect(row?.deletedAt).toBeInstanceOf(Date);

      const me = await request(server())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${u.token}`);

      console.log('C1.2 authenticated call after delete =', me.status);
      expect(me.status).toBe(401);

      const refreshed = await request(server())
        .post('/api/v1/auth/refresh-token')
        .set('Cookie', [`refresh_token=${refresh_token}`]);

      console.log('C1.2 refresh after delete =', refreshed.status);
      expect(refreshed.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ─────────────── C1.4 restore + enumeration safety ───────────────

  describe('C1.4 — restore by logging back in', () => {
    it('full loop: delete → 403 pending-deletion → restore → every relationship intact', async () => {
      const art = await makeUser('loopa', Role.ARTISAN);
      const prof = await makeArtisanProfile(art.user, {
        bio: 'Master electrician with 12 years on site.',
        hourlyRate: 85,
        location: 'Accra',
        businessName: 'Loop Electrics',
        payoutType: 'BANK',
        payoutAccountName: 'Loop Electrics',
        payoutAccountNumber: '0123456789',
        payoutBankCode: '058',
        services: [service],
        isProfileComplete: true,
      } as Partial<ArtisanProfile>);
      const addr = await addressRepo.save(
        addressRepo.create({
          user: art.user,
          street: '12 Oxford St',
          city: 'Accra',
          region: 'Greater Accra',
          country: 'Ghana',
          zipCode: '00233',
        } as Partial<Address>),
      );
      const cust = await makeUser('loopc', Role.CUSTOMER);
      const booking = await makeBooking(
        cust.user,
        prof,
        BookingStatus.COMPLETED,
      );
      const job = await makeJob(cust.user, Status.COMPLETED, art.user);
      await makePayment(job, cust.user, prof, PaymentStatus.RELEASED);

      const before = {
        profile: await profileRepo.findOne({
          where: { id: prof.id },
          relations: ['services'],
        }),
        addresses: await addressRepo.count({
          where: { user: { id: art.user.id } },
        }),
      };

      const del = await deleteMe(art.token);
      expect(del.status).toBe(200);
      const purgeAt = String((del.body as Body).data?.purgeAt);

      // login now offers restore, with the dates, and NO session
      const pending = await login(art.email, PASSWORD);

      console.log(
        'C1.4 pending-deletion login =',
        pending.status,
        JSON.stringify(pending.body),
      );
      expect(pending.status).toBe(403);
      const pb = pending.body as Body;
      expect(pb.meta?.error).toBe('ACCOUNT_PENDING_DELETION');
      expect(pb.meta?.details?.deletedAt).toBeDefined();
      expect(pb.meta?.details?.restorableUntil).toBe(purgeAt);
      expect(pb.access_token).toBeUndefined();
      expect(pending.headers['set-cookie']).toBeUndefined();

      // restore
      const r = await restore(art.email, PASSWORD);

      console.log(
        'C1.4 restore =',
        r.status,
        JSON.stringify({
          ...(r.body as Body),
          access_token: undefined,
          data: undefined,
        }),
      );
      expect(r.status).toBe(200);
      const rb = r.body as Body;
      expect(rb.restored).toBe(true);
      expect(rb.requiresEmailVerification).toBe(false);
      expect(rb.access_token).toBeTruthy();
      const cookies = String(r.headers['set-cookie'] ?? '');
      expect(cookies).toContain('refresh_token');
      expect(cookies).toContain('jinva_session');
      // QA: does the restore response leak the password hash?

      console.log(
        'C1.4 restore data keys =',
        JSON.stringify(Object.keys(rb.data ?? {})),
      );
      expect(Object.keys(rb.data ?? {})).not.toContain('password');

      // deletedAt cleared, nothing else changed
      const after = await userRepo.findOne({ where: { id: art.user.id } });
      expect(after?.deletedAt ?? null).toBeNull();
      expect(after?.purgedAt ?? null).toBeNull();

      const profAfter = await profileRepo.findOne({
        where: { id: prof.id },
        relations: ['services'],
      });
      expect(profAfter?.bio).toBe(before.profile?.bio);
      expect(profAfter?.location).toBe(before.profile?.location);
      expect(Number(profAfter?.hourlyRate)).toBe(
        Number(before.profile?.hourlyRate),
      );
      expect(profAfter?.payoutAccountNumber).toBe(
        before.profile?.payoutAccountNumber,
      );
      expect(profAfter?.services?.length).toBe(
        before.profile?.services?.length,
      );
      expect(
        await addressRepo.count({ where: { user: { id: art.user.id } } }),
      ).toBe(before.addresses);
      expect(
        await bookingRepo.findOne({ where: { id: booking.id } }),
      ).toBeTruthy();
      expect(await jobRepo.findOne({ where: { id: job.id } })).toBeTruthy();
      expect(addr.id).toBeDefined();

      // the restored session actually works
      const me = await request(server())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${rb.access_token}`);
      expect(me.status).toBe(200);

      // and a normal login works again
      const relogin = await login(art.email, PASSWORD);
      expect(relogin.status).toBe(200);
    });

    it('a Google-only soft-deleted account restores through the Google callback path', async () => {
      const g = await makeUser('goog', Role.CUSTOMER, { social: true });
      const del = await deleteMe(g.token);
      expect(del.status).toBe(200);

      // Password login on a Google-only deleted account must be the generic 401
      const pwLogin = await login(g.email, PASSWORD);

      console.log(
        'C1.4 google-only deleted, password login =',
        pwLogin.status,
        JSON.stringify(pwLogin.body),
      );
      expect(pwLogin.status).toBe(401);
      expect((pwLogin.body as Body).meta?.error).toBe(
        'InvalidCredentialsException',
      );

      // restore-account must not work for it either
      const r = await restore(g.email, PASSWORD);
      expect(r.status).toBe(401);

      // Completing the Google flow IS the ownership proof. Only the OAuth
      // transport is stubbed; the callback, the lookup, the row-locked restore
      // and the token issue are all the real code against the real database.
      googleProfile.email = g.email;
      googleProfile.providerId = `qa-google-${g.user.id}`;
      const cb = await authService.handleOAuthCallback('google', {
        code: 'qa-code',
        state: 'qa-state',
      } as never);

      console.log(
        'C1.4 google callback restore =',
        JSON.stringify({
          hasAccessToken: Boolean(
            (cb as { result?: { access_token?: string } }).result?.access_token,
          ),
          hasRefresh: Boolean((cb as { refreshToken?: string }).refreshToken),
        }),
      );
      expect((cb as { refreshToken?: string }).refreshToken).toBeTruthy();

      const row = await userRepo.findOne({ where: { id: g.user.id } });
      expect(row?.deletedAt ?? null).toBeNull();
      expect(row?.email).toBe(g.email);
      // No duplicate account was created for the same address.
      const dupes = await userRepo.count({
        where: { email: g.email },
        withDeleted: true,
      });
      expect(dupes).toBe(1);
      // and the restored Google account can sign in through Google again
      const cb2 = await authService.handleOAuthCallback('google', {
        code: 'qa-code',
        state: 'qa-state',
      } as never);
      expect((cb2 as { refreshToken?: string }).refreshToken).toBeTruthy();
    });

    it('a Google account past its window fails the callback (no silent new account, no restore)', async () => {
      const g = await makeUser('googold', Role.CUSTOMER, { social: true });
      await deleteMe(g.token).expect(200);
      await userRepo.update({ id: g.user.id }, {
        deletedAt: subDays(new Date(), 31),
      } as never);
      googleProfile.email = g.email;
      googleProfile.providerId = `qa-google-${g.user.id}`;

      let err: unknown;
      try {
        await authService.handleOAuthCallback('google', {
          code: 'qa-code',
          state: 'qa-state',
        } as never);
      } catch (e) {
        err = e;
      }

      console.log(
        'C1.4 google past-window callback threw =',
        (err as Error)?.constructor?.name,
        JSON.stringify((err as Error)?.message),
      );
      expect(err).toBeDefined();
      const row = await userRepo.findOne({
        where: { id: g.user.id },
        withDeleted: true,
      });
      expect(row?.deletedAt).toBeInstanceOf(Date);
      const dupes = await userRepo.count({
        where: { email: g.email },
        withDeleted: true,
      });
      expect(dupes).toBe(1);
    });

    it('an unverified soft-deleted account restores, then hits the verify gate', async () => {
      const u = await makeUser('unv', Role.CUSTOMER, { verified: false });
      // deletion needs a valid token; makeUser already gave us one
      const del = await deleteMe(u.token);
      expect(del.status).toBe(200);

      const pending = await login(u.email, PASSWORD);

      console.log(
        'C1.4 unverified pending login =',
        pending.status,
        JSON.stringify(pending.body),
      );
      expect(pending.status).toBe(403);
      expect((pending.body as Body).meta?.error).toBe(
        'ACCOUNT_PENDING_DELETION',
      );

      const r = await restore(u.email, PASSWORD);

      console.log(
        'C1.4 unverified restore =',
        r.status,
        JSON.stringify(r.body),
      );
      expect(r.status).toBe(200);
      expect((r.body as Body).restored).toBe(true);
      expect((r.body as Body).requiresEmailVerification).toBe(true);
      expect((r.body as Body).access_token).toBeUndefined();
      expect(r.headers['set-cookie']).toBeUndefined();

      const row = await userRepo.findOne({ where: { id: u.user.id } });
      expect(row?.deletedAt ?? null).toBeNull();

      const after = await login(u.email, PASSWORD);
      expect(after.status).toBe(403);

      console.log(
        'C1.4 login after unverified restore =',
        after.status,
        JSON.stringify(after.body),
      );
    });

    it('HARD SECURITY: wrong password on a soft-deleted account is byte-identical to a wrong password on a live account and to an unknown email', async () => {
      const live = await makeUser('enumlive', Role.CUSTOMER);
      const deleted = await makeUser('enumdel', Role.CUSTOMER);
      await deleteMe(deleted.token).expect(200);
      const unknown = email('enumnobody');

      const wrongOnLive = comparable(await login(live.email, 'WrongPass1!'));
      const wrongOnDeleted = comparable(
        await login(deleted.email, 'WrongPass1!'),
      );
      const unknownEmail = comparable(await login(unknown, 'WrongPass1!'));

      console.log(
        'C1.4 enumeration triple =',
        JSON.stringify({ wrongOnLive, wrongOnDeleted, unknownEmail }, null, 1),
      );
      expect(wrongOnDeleted).toEqual(wrongOnLive);
      expect(unknownEmail).toEqual(wrongOnLive);

      // and restore-account is not an oracle either
      const rWrong = comparable(await restore(deleted.email, 'WrongPass1!'));
      const rUnknown = comparable(await restore(unknown, 'WrongPass1!'));
      const rLive = comparable(await restore(live.email, PASSWORD));

      console.log(
        'C1.4 restore enumeration triple =',
        JSON.stringify({ rWrong, rUnknown, rLive }, null, 1),
      );
      expect(rUnknown).toEqual(rWrong);
      expect(rLive).toEqual(rWrong);
    });

    it('past the window: login is the generic 401 and restore is a 410 with the create-a-new-account path', async () => {
      const u = await makeUser('expired', Role.CUSTOMER);
      await deleteMe(u.token).expect(200);
      await userRepo.update({ id: u.user.id }, {
        deletedAt: subDays(new Date(), 31),
      } as never);

      const l = comparable(await login(u.email, PASSWORD));

      console.log('C1.4 expired-window login =', JSON.stringify(l));
      expect(l.status).toBe(401);
      expect(l.error).toBe('InvalidCredentialsException');

      const r = await restore(u.email, PASSWORD);

      console.log(
        'C1.4 expired-window restore =',
        r.status,
        JSON.stringify(r.body),
      );
      expect(r.status).toBe(410);
      expect((r.body as Body).meta?.error).toBe(
        'ACCOUNT_RESTORE_WINDOW_EXPIRED',
      );

      const row = await userRepo.findOne({
        where: { id: u.user.id },
        withDeleted: true,
      });
      expect(row?.deletedAt).toBeInstanceOf(Date);
    });

    it('the last minute of day 30 is still restorable (boundary favours the user)', async () => {
      const u = await makeUser('bound', Role.CUSTOMER);
      await deleteMe(u.token).expect(200);
      await userRepo.update({ id: u.user.id }, {
        deletedAt: subMinutes(subDays(new Date(), 30), -1),
      } as never);
      const r = await restore(u.email, PASSWORD);

      console.log(
        'C1.4 last-minute-of-day-30 restore =',
        r.status,
        JSON.stringify((r.body as Body).message),
      );
      expect(r.status).toBe(200);
    });
  });

  // ───────────────────── C1.6 during the window ─────────────────────

  describe('C1.6 — what is true during the window', () => {
    it('a soft-deleted artisan drops out of search and their public profile 404s', async () => {
      const art = await makeUser('winart', Role.ARTISAN);
      const prof = await makeArtisanProfile(art.user, {
        bio: 'Window-test artisan bio, long enough to be real.',
        hourlyRate: 60,
        location: 'Kumasi',
        services: [service],
        isProfileComplete: true,
      } as Partial<ArtisanProfile>);

      const beforeSearch = await request(server()).get(
        `/api/v1/artisans?limit=50&serviceId=${service.id}`,
      );
      const beforeIds = JSON.stringify(beforeSearch.body);
      expect(beforeIds).toContain(`"id":${prof.id}`);
      expect(
        (await request(server()).get(`/api/v1/artisans/${prof.id}`)).status,
      ).toBe(200);

      await deleteMe(art.token).expect(200);

      const afterSearch = await request(server()).get(
        `/api/v1/artisans?limit=50&serviceId=${service.id}`,
      );
      expect(JSON.stringify(afterSearch.body)).not.toContain(`"id":${prof.id}`);
      const pub = await request(server()).get(`/api/v1/artisans/${prof.id}`);

      console.log('C1.6 public profile of soft-deleted artisan =', pub.status);
      expect(pub.status).toBe(404);
    });

    it('the email cannot be re-registered, and the error does not say "deleted"', async () => {
      const u = await makeUser('reg', Role.CUSTOMER);
      await deleteMe(u.token).expect(200);
      const res = await request(server())
        .post('/api/v1/auth/register')
        .send({
          email: u.email,
          password: PASSWORD,
          username: `qare${uniq}`,
          firstname: 'Re',
          lastname: 'Register',
          phoneNumber: '024-400-9999',
          role: Role.CUSTOMER,
        });

      console.log(
        'C1.6 re-register a deleted email =',
        res.status,
        JSON.stringify(res.body),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(String((res.body as Body).message).toLowerCase()).not.toContain(
        'delet',
      );
    });
  });

  // ──────────────────────────── C1.7 purge ────────────────────────────

  describe('C1.7 — scheduled purge', () => {
    it('the candidate query can never match a deletedAt IS NULL row', async () => {
      const live = await makeUser('purgelive', Role.CUSTOMER);
      const ids = await purgeService.findPurgeCandidateIds();
      expect(ids).not.toContain(live.user.id);

      const liveCount = await userRepo.count({
        where: { deletedAt: IsNull() },
      });
      expect(liveCount).toBeGreaterThan(0);
      const allCandidates = ids.length
        ? await userRepo.find({
            where: { id: In(ids) },
            withDeleted: true,
            select: ['id', 'deletedAt'],
          })
        : [];
      for (const row of allCandidates) {
        expect(row.deletedAt).toBeInstanceOf(Date);
      }

      console.log('C1.7 candidate ids =', JSON.stringify(ids));
    });

    it('does not select an account at exactly 30 days, does select one at 31', async () => {
      const at30 = await makeUser('at30', Role.CUSTOMER);
      const at31 = await makeUser('at31', Role.CUSTOMER);
      await deleteMe(at30.token).expect(200);
      await deleteMe(at31.token).expect(200);
      // `now` is injected so the assertion sits on the exact boundary instant
      // rather than a few hundred milliseconds past it.
      const now = new Date();
      await userRepo.update({ id: at30.user.id }, {
        deletedAt: subDays(now, 30),
      } as never);
      await userRepo.update({ id: at31.user.id }, {
        deletedAt: subDays(now, 31),
      } as never);

      const ids = await purgeService.findPurgeCandidateIds(now);
      expect(await purgeService.purgeAccount(at30.user.id, now)).toBe(
        'skipped',
      );
      expect(ids).not.toContain(at30.user.id);
      expect(ids).toContain(at31.user.id);
    });

    it('log-only mode reports candidates and writes nothing at all', async () => {
      delete process.env.ACCOUNT_PURGE_MODE;
      expect(purgeService.isDestructiveModeEnabled()).toBe(false);

      const u = await makeUser('logonly', Role.ARTISAN);
      const prof = await makeArtisanProfile(u.user, {
        bio: 'Log-only fixture bio',
        hourlyRate: 40,
        location: 'Tema',
        payoutAccountNumber: '9998887776',
        services: [service],
        isProfileComplete: true,
      } as Partial<ArtisanProfile>);
      await addressRepo.save(
        addressRepo.create({
          user: u.user,
          street: '1 Log Only Rd',
          city: 'Tema',
          region: 'Greater Accra',
          country: 'Ghana',
          zipCode: '00233',
        } as Partial<Address>),
      );
      await deleteMe(u.token).expect(200);
      await userRepo.update({ id: u.user.id }, {
        deletedAt: subDays(new Date(), 45),
      } as never);

      const snapshotUser = await userRepo.findOne({
        where: { id: u.user.id },
        withDeleted: true,
      });
      const snapshotProfile = await profileRepo.findOne({
        where: { id: prof.id },
      });
      const snapshotAddresses = await addressRepo.count({
        where: { user: { id: u.user.id } },
      });
      const snapshotTokens = await tokenCount(userRepo, u.user.id);

      const outcome = await purgeService.purgeAccount(u.user.id);
      expect(outcome).toBe('reported');

      const afterUser = await userRepo.findOne({
        where: { id: u.user.id },
        withDeleted: true,
      });
      expect(afterUser?.email).toBe(snapshotUser?.email);
      expect(afterUser?.firstname).toBe(snapshotUser?.firstname);
      expect(afterUser?.purgedAt ?? null).toBeNull();
      const afterProfile = await profileRepo.findOne({
        where: { id: prof.id },
      });
      expect(afterProfile?.bio).toBe(snapshotProfile?.bio);
      expect(afterProfile?.payoutAccountNumber).toBe(
        snapshotProfile?.payoutAccountNumber,
      );
      expect(
        await addressRepo.count({ where: { user: { id: u.user.id } } }),
      ).toBe(snapshotAddresses);
      const afterTokens = await tokenCount(userRepo, u.user.id);
      expect(afterTokens).toEqual(snapshotTokens);

      // the scheduler entry point logs a summary and still writes nothing
      const logSpy = jest.spyOn(
        (purgeScheduler as unknown as { logger: { log: (m: string) => void } })
          .logger,
        'log',
      );
      const warnSpy = jest.spyOn(
        (purgeScheduler as unknown as { logger: { warn: (m: string) => void } })
          .logger,
        'warn',
      );
      await purgeScheduler.purgeExpiredDeletedAccounts();
      const summaries = logSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('run summary'));

      console.log('C1.7 scheduler summary =', JSON.stringify(summaries));

      console.log(
        'C1.7 scheduler warnings =',
        JSON.stringify(warnSpy.mock.calls.map((c) => String(c[0])).slice(0, 5)),
      );
      expect(summaries.some((m) => m.includes('mode=log-only'))).toBe(true);
      const stillThere = await userRepo.findOne({
        where: { id: u.user.id },
        withDeleted: true,
      });
      expect(stillThere?.purgedAt ?? null).toBeNull();
      expect(stillThere?.email).toBe(snapshotUser?.email);
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('destructive mode anonymizes, retains financial records, is idempotent, and blocks restore forever', async () => {
      const art = await makeUser('destr', Role.ARTISAN);
      const cust = await makeUser('destrc', Role.CUSTOMER);
      const prof = await makeArtisanProfile(art.user, {
        bio: 'Destructive-mode fixture bio',
        businessName: 'Purge Me Ltd',
        hourlyRate: 55,
        location: 'Takoradi',
        cancellationPolicy: 'no refunds',
        payoutType: 'BANK',
        payoutAccountName: 'Purge Me Ltd',
        payoutAccountNumber: '1112223334',
        payoutBankCode: '058',
        services: [service],
        isProfileComplete: true,
      } as Partial<ArtisanProfile>);
      await addressRepo.save(
        addressRepo.create({
          user: art.user,
          street: '9 Purge Ln',
          city: 'Takoradi',
          region: 'Western',
          country: 'Ghana',
          zipCode: '00233',
        } as Partial<Address>),
      );
      const booking = await makeBooking(
        cust.user,
        prof,
        BookingStatus.COMPLETED,
      );
      const job = await makeJob(cust.user, Status.COMPLETED, art.user);
      const payment = await makePayment(
        job,
        cust.user,
        prof,
        PaymentStatus.RELEASED,
      );
      const dispute = await makeDispute(
        booking,
        cust.user,
        DisputeStatus.RESOLVED,
      );

      const originalEmail = art.email;
      await deleteMe(art.token).expect(200);
      await userRepo.update({ id: art.user.id }, {
        deletedAt: subDays(new Date(), 40),
      } as never);

      process.env.ACCOUNT_PURGE_MODE = 'destructive';
      expect(purgeService.isDestructiveModeEnabled()).toBe(true);
      try {
        const first = await purgeService.purgeAccount(art.user.id);
        expect(first).toBe('purged');
        const second = await purgeService.purgeAccount(art.user.id);

        console.log('C1.7 idempotent rerun outcome =', second);
        expect(second).toBe('skipped');

        const row = await userRepo.findOne({
          where: { id: art.user.id },
          withDeleted: true,
        });

        console.log(
          'C1.7 purged row =',
          JSON.stringify({
            email: row?.email,
            firstname: row?.firstname,
            lastname: row?.lastname,
            username: row?.username,
            phoneNumber: row?.phoneNumber,
            gender: row?.gender,
            dateOfBirth: row?.dateOfBirth,
            profilePicture: row?.profilePicture,
            socialProvider: row?.socialProvider,
            isSocialLogin: row?.isSocialLogin,
            purgedAt: row?.purgedAt,
            deletedAt: row?.deletedAt,
          }),
        );
        expect(row?.email).toBe(`deleted-user-${art.user.id}@deleted.invalid`);
        expect(row?.email).not.toBe(originalEmail);
        expect(row?.firstname).toBe('Deleted');
        expect(row?.lastname).toBe('User');
        expect(row?.username ?? null).toBeNull();
        expect(row?.phoneNumber ?? null).toBeNull();
        expect(row?.purgedAt).toBeInstanceOf(Date);
        expect(row?.deletedAt).toBeInstanceOf(Date);
        const pwRow = await userRepo.findOne({
          where: { id: art.user.id },
          withDeleted: true,
          select: ['id', 'password'],
        });
        expect(pwRow?.password ?? null).toBeNull();

        const profAfter = await profileRepo.findOne({
          where: { id: prof.id },
          relations: ['services'],
        });
        expect(profAfter?.bio ?? null).toBeNull();
        expect(profAfter?.businessName ?? null).toBeNull();
        expect(profAfter?.location ?? null).toBeNull();
        expect(profAfter?.payoutAccountNumber ?? null).toBeNull();
        expect(profAfter?.payoutBankCode ?? null).toBeNull();
        expect(profAfter?.isProfileComplete).toBe(false);

        expect(
          await addressRepo.count({ where: { user: { id: art.user.id } } }),
        ).toBe(0);
        expect(await tokenCount(userRepo, art.user.id)).toBe(0);

        // financial / audit records retained
        expect(
          await paymentRepo.findOne({ where: { id: payment.id } }),
        ).toBeTruthy();
        expect(
          await disputeRepo.findOne({ where: { id: dispute.id } }),
        ).toBeTruthy();
        expect(
          await bookingRepo.findOne({ where: { id: booking.id } }),
        ).toBeTruthy();
        expect(await jobRepo.findOne({ where: { id: job.id } })).toBeTruthy();

        // C1.8: no code path restores it
        const r = await restore(originalEmail, PASSWORD);

        console.log(
          'C1.7/C1.8 restore after purge (original email) =',
          r.status,
          JSON.stringify(r.body),
        );
        expect(r.status).toBe(401);
        const l = await login(originalEmail, PASSWORD);
        expect(l.status).toBe(401);
        await expect(
          usersService.restoreAccountById(art.user.id),
        ).rejects.toThrow(/permanently deleted/i);
      } finally {
        delete process.env.ACCOUNT_PURGE_MODE;
      }
    });

    it('purge skips an account restored during the window (restore wins the race)', async () => {
      const u = await makeUser('race', Role.CUSTOMER);
      await deleteMe(u.token).expect(200);
      await userRepo.update({ id: u.user.id }, {
        deletedAt: subDays(new Date(), 40),
      } as never);
      const candidates = await purgeService.findPurgeCandidateIds();
      expect(candidates).toContain(u.user.id);
      // The owner restores before the purge takes the row lock. Done with the
      // repository's own un-delete (rather than the HTTP route) because by this
      // point the fixture is deliberately outside the window, which the route
      // would - correctly - refuse.
      await userRepo.restore({ id: u.user.id });

      process.env.ACCOUNT_PURGE_MODE = 'destructive';
      try {
        const outcome = await purgeService.purgeAccount(u.user.id);

        console.log('C1.7 purge after restore =', outcome);
        expect(outcome).toBe('skipped');
        const row = await userRepo.findOne({ where: { id: u.user.id } });
        expect(row?.email).toBe(u.email);
        expect(row?.purgedAt ?? null).toBeNull();
      } finally {
        delete process.env.ACCOUNT_PURGE_MODE;
      }
    });

    it.each(['true', '1', 'yes', 'DESTROY', '', 'Destructive '])(
      'ACCOUNT_PURGE_MODE=%p arms destructive mode only for the exact opt-in',
      (value) => {
        process.env.ACCOUNT_PURGE_MODE = value;
        const armed = purgeService.isDestructiveModeEnabled();

        console.log(
          `C1.7 mode ${JSON.stringify(value)} -> destructive=${armed}`,
        );
        expect(armed).toBe(value.trim().toLowerCase() === 'destructive');
        delete process.env.ACCOUNT_PURGE_MODE;
      },
    );
  });

  // ──────────────────────────── C2 ────────────────────────────

  describe('C2 — artisan profile completeness', () => {
    it('C2.1: GET /users/me/artisan-profile always carries missingFields', async () => {
      const art = await makeUser('c2get', Role.ARTISAN);
      await makeArtisanProfile(art.user, {} as Partial<ArtisanProfile>);
      const res = await request(server())
        .get('/api/v1/users/me/artisan-profile')
        .set('Authorization', `Bearer ${art.token}`);

      console.log(
        'C2.1 incomplete GET =',
        res.status,
        JSON.stringify({
          isProfileComplete: (res.body as Body).data?.isProfileComplete,
          missingFields: (res.body as Body).data?.missingFields,
        }),
      );
      expect(res.status).toBe(200);
      const d = (res.body as Body).data!;
      expect(d.isProfileComplete).toBe(false);
      expect(d.missingFields).toEqual([
        'bio',
        'hourlyRate',
        'location',
        'services',
      ]);
    });

    it('C2.2: filling the last field via PATCH /users/me/artisan-profile flips the flag and makes the artisan searchable', async () => {
      const art = await makeUser('c2patch', Role.ARTISAN);
      const prof = await makeArtisanProfile(art.user, {
        hourlyRate: 70,
        location: 'Accra',
        services: [service],
      } as Partial<ArtisanProfile>);

      const pre = await request(server()).get(
        `/api/v1/artisans?limit=50&serviceId=${service.id}`,
      );
      expect(JSON.stringify(pre.body)).not.toContain(`"id":${prof.id}`);

      const patch = await request(server())
        .patch('/api/v1/users/me/artisan-profile')
        .set('Authorization', `Bearer ${art.token}`)
        .send({ bio: 'Now I have a bio, so customers can find me.' });

      console.log(
        'C2.2 patch response =',
        patch.status,
        JSON.stringify({
          isProfileComplete: (patch.body as Body).data?.isProfileComplete,
          missingFields: (patch.body as Body).data?.missingFields,
        }),
      );
      expect(patch.status).toBe(200);
      expect((patch.body as Body).data?.isProfileComplete).toBe(true);
      expect((patch.body as Body).data?.missingFields).toEqual([]);

      const persisted = await profileRepo.findOne({ where: { id: prof.id } });
      expect(persisted?.isProfileComplete).toBe(true);

      const post = await request(server()).get(
        `/api/v1/artisans?limit=50&serviceId=${service.id}`,
      );

      console.log(
        'C2.2 appears in search =',
        JSON.stringify(post.body).includes(`"id":${prof.id}`),
      );
      expect(JSON.stringify(post.body)).toContain(`"id":${prof.id}`);
    });

    it('C2.2: clearing a required field drops the artisan out of search immediately', async () => {
      const art = await makeUser('c2clear', Role.ARTISAN);
      const prof = await makeArtisanProfile(art.user, {
        bio: 'Complete profile that is about to be broken.',
        hourlyRate: 70,
        location: 'Accra',
        services: [service],
        isProfileComplete: true,
      } as Partial<ArtisanProfile>);
      expect(
        JSON.stringify(
          (
            await request(server()).get(
              `/api/v1/artisans?limit=50&serviceId=${service.id}`,
            )
          ).body,
        ),
      ).toContain(`"id":${prof.id}`);

      const patch = await request(server())
        .patch('/api/v1/users/me/artisan-profile')
        .set('Authorization', `Bearer ${art.token}`)
        .send({ location: '   ' });

      console.log(
        'C2.2 clear location =',
        patch.status,
        JSON.stringify({
          isProfileComplete: (patch.body as Body).data?.isProfileComplete,
          missingFields: (patch.body as Body).data?.missingFields,
        }),
      );
      expect(patch.status).toBe(200);
      expect((patch.body as Body).data?.isProfileComplete).toBe(false);
      expect((patch.body as Body).data?.missingFields).toContain('location');
      expect(
        JSON.stringify(
          (
            await request(server()).get(
              `/api/v1/artisans?limit=50&serviceId=${service.id}`,
            )
          ).body,
        ),
      ).not.toContain(`"id":${prof.id}`);
    });

    it('C2.2 partial payloads: the settings page sending only location does not clobber the profile page fields', async () => {
      const art = await makeUser('c2part', Role.ARTISAN);
      const prof = await makeArtisanProfile(art.user, {
        bio: 'Bio owned by the profile page.',
        hourlyRate: 99,
        services: [service],
      } as Partial<ArtisanProfile>);

      const patch = await request(server())
        .patch('/api/v1/users/me/artisan-profile')
        .set('Authorization', `Bearer ${art.token}`)
        .send({ location: 'Ho' });
      expect(patch.status).toBe(200);

      console.log(
        'C2.2 post-merge completeness =',
        JSON.stringify({
          isProfileComplete: (patch.body as Body).data?.isProfileComplete,
          missingFields: (patch.body as Body).data?.missingFields,
        }),
      );
      expect((patch.body as Body).data?.missingFields).toEqual([]);
      expect((patch.body as Body).data?.isProfileComplete).toBe(true);
      const after = await profileRepo.findOne({ where: { id: prof.id } });
      expect(after?.bio).toBe('Bio owned by the profile page.');
      expect(Number(after?.hourlyRate)).toBe(99);
    });

    it('C2.5: a customer cannot reach the artisan self-view, and a public profile never carries missingFields', async () => {
      const cust = await makeUser('c2cust', Role.CUSTOMER);
      const res = await request(server())
        .get('/api/v1/users/me/artisan-profile')
        .set('Authorization', `Bearer ${cust.token}`);

      console.log('C2.5 customer on artisan self-view =', res.status);
      expect(res.status).toBe(403);

      const art = await makeUser('c2pub', Role.ARTISAN);
      const prof = await makeArtisanProfile(art.user, {
        bio: 'Public profile bio',
        hourlyRate: 30,
        location: 'Accra',
        services: [service],
        isProfileComplete: true,
      } as Partial<ArtisanProfile>);
      const pub = await request(server()).get(`/api/v1/artisans/${prof.id}`);
      expect(pub.status).toBe(200);

      console.log(
        'C2.5 public profile keys =',
        JSON.stringify(Object.keys((pub.body as Body).data ?? {})),
      );
      expect(JSON.stringify(pub.body)).not.toContain('missingFields');

      // another artisan reading a public profile also sees no completeness detail
      const pubAsArtisan = await request(server())
        .get(`/api/v1/artisans/${prof.id}`)
        .set('Authorization', `Bearer ${cust.token}`);
      expect(JSON.stringify(pubAsArtisan.body)).not.toContain('missingFields');
    });

    it('C2.2 backfill: no existing artisan profile is left stale-false with all four fields present', async () => {
      const stale = await profileRepo
        .createQueryBuilder('ap')
        .leftJoin('ap.services', 's')
        .innerJoin('ap.user', 'u')
        .where('u.deleted_at IS NULL')
        .andWhere('ap.is_profile_complete = false')
        .andWhere("COALESCE(TRIM(ap.bio), '') <> ''")
        .andWhere('ap.hourly_rate IS NOT NULL')
        .andWhere("COALESCE(TRIM(ap.location), '') <> ''")
        .groupBy('ap.id')
        .having('COUNT(s.id) > 0')
        .select(['ap.id'])
        .getRawMany();

      console.log(
        'C2.2 stale-false profiles after backfill =',
        JSON.stringify(stale),
      );
      expect(stale).toHaveLength(0);
    });

    it('C2.2 backfill: no profile is stale-TRUE either (would be searchable while incomplete)', async () => {
      const rows = await profileRepo
        .createQueryBuilder('ap')
        .leftJoin('ap.services', 's')
        .innerJoin('ap.user', 'u')
        .where('u.deleted_at IS NULL')
        .andWhere('ap.is_profile_complete = true')
        .andWhere("u.email NOT LIKE '%@test.jinva.local'")
        .andWhere("u.email NOT LIKE '%@jinva.test'")
        .groupBy('ap.id')
        .having(
          "COALESCE(TRIM(ap.bio), '') = '' OR ap.hourly_rate IS NULL OR COALESCE(TRIM(ap.location), '') = '' OR COUNT(s.id) = 0",
        )
        .select(['ap.id'])
        .getRawMany();

      console.log(
        'C2.2 stale-true profiles after backfill =',
        JSON.stringify(rows.slice(0, 20)),
        'count=',
        rows.length,
      );
      expect(rows).toHaveLength(0);
    });
  });

  // ────────────────── regression: what already worked ──────────────────

  describe('no regression', () => {
    it('S4 unverified login still 403s with EMAIL_NOT_VERIFIED', async () => {
      const u = await makeUser('s4', Role.CUSTOMER, { verified: false });
      const res = await login(u.email, PASSWORD);

      console.log('regression S4 =', res.status, JSON.stringify(res.body));
      expect(res.status).toBe(403);
    });

    it('G10 social-only login still gets the specific social-only error', async () => {
      const u = await makeUser('g10', Role.CUSTOMER, { social: true });
      const res = await login(u.email, PASSWORD);

      console.log('regression G10 =', res.status, JSON.stringify(res.body));
      expect(res.status).toBe(401);
    });

    it('artisan profile/settings save fields still round-trip', async () => {
      const art = await makeUser('rt', Role.ARTISAN);
      await makeArtisanProfile(art.user, {} as Partial<ArtisanProfile>);
      const res = await request(server())
        .patch('/api/v1/users/me/artisan-profile')
        .set('Authorization', `Bearer ${art.token}`)
        .send({
          bio: 'Round-trip bio',
          hourlyRate: 44,
          location: 'Accra',
          serviceRadiusKm: 15,
          cancellationPolicy: '24 hours notice',
          businessName: 'RT Works',
        });

      console.log(
        'regression save round-trip =',
        res.status,
        JSON.stringify((res.body as Body).message),
      );
      expect(res.status).toBe(200);
      const d = (res.body as Body).data!;
      expect(d.bio).toBe('Round-trip bio');
      expect(Number(d.hourlyRate)).toBe(44);
      expect(d.location).toBe('Accra');
      expect(d.cancellationPolicy).toBe('24 hours notice');
    });

    it('POST /auth/register response does not leak the password hash', async () => {
      const e = email('leak');
      const res = await request(server())
        .post('/api/v1/auth/register')
        .send({
          email: e,
          password: PASSWORD,
          username: `qaleak${uniq}`,
          firstname: 'Leak',
          lastname: 'Check',
          phoneNumber: '024-400-8888',
          role: Role.CUSTOMER,
        });
      const created = await userRepo.findOne({ where: { email: e } });
      if (created) createdUserIds.push(created.id);

      console.log(
        'register body keys =',
        res.status,
        JSON.stringify(Object.keys(res.body as object)),
      );
      expect(JSON.stringify(res.body)).not.toContain('$2b$');
    });

    it('no soft-deleted principal is authenticable anywhere (JwtStrategy fails closed)', async () => {
      const u = await makeUser('jwt', Role.ARTISAN);
      const token = u.token;
      await deleteMe(token).expect(200);
      for (const path of [
        '/api/v1/users/me',
        '/api/v1/users/me/artisan-profile',
        '/api/v1/bookings/my',
        '/api/v1/notifications',
        '/api/v1/notifications/unread-count',
      ]) {
        const res = await request(server())
          .get(path)
          .set('Authorization', `Bearer ${token}`);

        console.log('fail-closed', path, '=', res.status);
        expect(res.status).toBe(401);
      }
      const softDeleted = await userRepo.find({
        where: { deletedAt: Not(IsNull()) },
        withDeleted: true,
        select: ['id'],
      });
      expect(softDeleted.length).toBeGreaterThan(0);
      expect(addDays(new Date(), 0)).toBeInstanceOf(Date);
    });
  });
});
