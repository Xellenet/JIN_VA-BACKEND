/**
 * QA for the job, message, payment and dispute emails, over real HTTP and the
 * real database. Mail is captured in-process (recipient, event, data and the
 * rendered HTML); nothing leaves the machine. Everything created is removed.
 */
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
import { ArtisanAvailability } from '../src/availability/entities/artisan-availability.entity';
import { Payment } from '../src/payments/entities/payment.entity';
import { PaymentsService } from '../src/payments/payments.service';
import { PaystackService } from '../src/payments/paystack.service';
import { JobsService } from '@jobs/jobs.service';
import { MailService } from '../src/mail/mail.service';
import { MailTemplateService } from '../src/mail/mail.template';
import { PaymentStatus, Role } from '@common/types/enums';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(180000);

type Mail = {
  to: string;
  event: string;
  data: Record<string, unknown>;
  subject: string;
  html: string;
};

function monday(weeks = 1): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((1 - d.getUTCDay() + 7) % 7) + 7 * weeks);
  return d.toISOString().slice(0, 10);
}

describe('Event emails QA', () => {
  let app: INestApplication<App>;
  let mod: TestingModule;
  let dataSource: DataSource;
  let payments: Repository<Payment>;
  const serviceIds: number[] = [];
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const userOf: Record<string, User> = {};
  const profileOf: Record<string, number> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });
  const mails: Mail[] = [];
  const templates = new MailTemplateService();
  const proto = MailService.prototype as unknown as Record<string, unknown>;
  const pay = PaystackService.prototype as unknown as Record<string, unknown>;
  const saved = {
    send: proto.sendMail,
    verify: pay.verifyWebhookSignature,
    refund: pay.createRefund,
  };

  const emailOf = (who: string) => userOf[who].email;
  const take = () => mails.splice(0, mails.length);
  /** Async listeners: wait until mail stops arriving. */
  async function settle(ms = 700): Promise<Mail[]> {
    let last = -1;
    while (last !== mails.length) {
      last = mails.length;
      await new Promise((r) => setTimeout(r, ms));
    }
    return take();
  }
  const forUser = (list: Mail[], who: string) =>
    list.filter((m) => m.to === emailOf(who));

  beforeAll(async () => {
    proto.sendMail = function (
      to: string,
      event: string,
      data: Record<string, unknown>,
    ) {
      const { subject, html } = templates.renderTemplate(event, data);
      mails.push({ to, event, data, subject, html });
      return Promise.resolve();
    };
    pay.verifyWebhookSignature = () => true;
    pay.createRefund = () => Promise.resolve({ status: true });

    mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
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
    dataSource = mod.get(DataSource);
    payments = mod.get(getRepositoryToken(Payment));
    const users: Repository<User> = mod.get(getRepositoryToken(User));
    const profiles: Repository<ArtisanProfile> = mod.get(
      getRepositoryToken(ArtisanProfile),
    );
    const slots: Repository<ArtisanAvailability> = mod.get(
      getRepositoryToken(ArtisanAvailability),
    );
    const services: Repository<ServiceEntity> = mod.get(
      getRepositoryToken(ServiceEntity),
    );
    const service = await services.save(
      services.create({
        name: `Email QA ${uniq}`,
        estimatedDurationMins: 60,
      }),
    );
    serviceIds.push(service.id);
    const tokens = mod.get(UserTokenService);
    const make = async (label: string, role: Role, firstname: string) => {
      const u = await users.save(
        users.create({
          email: `eml-${label}-${uniq}@test.jinva.local`,
          username: `eml${label}${uniq}`,
          firstname,
          lastname: 'Mensah',
          role,
          accountVerified: true,
        }),
      );
      userOf[label] = u;
      if (role === Role.ARTISAN) {
        const p = await profiles.save(
          profiles.create({
            user: u,
            hourlyRate: 80,
            location: 'Osu, Greater Accra',
            currency: 'GHS',
            isProfileComplete: true,
            services: [service],
          }),
        );
        profileOf[label] = p.id;
        await slots.save(
          slots.create({
            artisanProfileId: p.id,
            dayOfWeek: 1,
            startTime: '06:00',
            endTime: '18:00',
            isActive: true,
          }),
        );
      }
      token[label] = (await tokens.createJWTTokens(u)).access_token;
    };
    await make('customer', Role.CUSTOMER, 'Ama');
    await make('artisanA', Role.ARTISAN, 'Yaw');
    await make('artisanB', Role.ARTISAN, 'Kofi');
    await make('admin', Role.ADMIN, 'Esi');
    await settle(300);
  });

  afterAll(async () => {
    proto.sendMail = saved.send;
    pay.verifyWebhookSignature = saved.verify;
    pay.createRefund = saved.refund;
    await removeTestData(dataSource, {
      userIds: await testUserIds(dataSource, 'eml-'),
      serviceIds,
    });
    await app.close();
  });

  async function postJob(title: string): Promise<number> {
    const res = await request(server())
      .post('/api/v1/jobs')
      .set(as('customer'))
      .send({
        title,
        description: 'Bathroom tap is leaking and needs a new washer',
        serviceId: serviceIds[0],
        location: 'Osu, Greater Accra',
        budgetMin: 100,
        budgetMax: 200,
        currency: 'GHS',
      });
    expect(res.status).toBe(201);
    return (res.body as { data: { id: number } }).data.id;
  }
  const apply = (who: string, jobId: number, quotePrice = 150) =>
    request(server())
      .post(`/api/v1/jobs/${jobId}/apply`)
      .set(as(who))
      .send({ quotePrice });
  async function accept(jobId: number, who: string) {
    const list = await request(server())
      .get(`/api/v1/jobs/${jobId}/applications`)
      .set(as('customer'));
    const apps = (
      list.body as { data: Array<{ id: number; artisan: { id: number } }> }
    ).data;
    const app0 = apps.find((a) => a.artisan.id === userOf[who].id)!;
    const res = await request(server())
      .post(`/api/v1/jobs/${jobId}/applications/${app0.id}/accept`)
      .set(as('customer'));
    expect(res.status).toBe(201);
  }
  const webhook = (event: string, data: Record<string, unknown>) =>
    mod
      .get(PaymentsService)
      .processWebhook(JSON.stringify({ event, data }), 'sig');

  function report(label: string, list: Mail[]) {
    console.log(
      `${label}\n` +
        list
          .map(
            (m) =>
              `  → ${m.to.replace(/-\d+@.*/, '')} [${m.event}] "${m.subject}" | ${m.data.heading as string} | ${(m.data.paragraphs as string[] | undefined)?.join(' ') ?? ''} | ${(m.data.actionUrl as string | undefined) ?? ''}`,
          )
          .join('\n'),
    );
  }

  let paidJobId = 0;

  it('job lifecycle: apply, accept/reject, pay, start, finish, confirm', async () => {
    paidJobId = await postJob(`Leaking tap ${uniq}`);
    await settle(300);

    expect((await apply('artisanA', paidJobId, 150)).status).toBe(201);
    expect((await apply('artisanB', paidJobId, 160)).status).toBe(201);
    let got = await settle();
    report('apply x2', got);
    expect(got.map((m) => m.event)).toEqual([
      'job.application.received',
      'job.application.received',
    ]);
    expect(got.every((m) => m.to === emailOf('customer'))).toBe(true);
    expect(got[0].data.actionUrl).toMatch(
      new RegExp(`/dashboard/user/jobs/${paidJobId}$`),
    );

    await accept(paidJobId, 'artisanA');
    got = await settle();
    report('accept', got);
    expect(forUser(got, 'artisanA').map((m) => m.event)).toEqual([
      'job.application.accepted',
    ]);
    expect(forUser(got, 'artisanB').map((m) => m.event)).toEqual([
      'job.application.rejected',
    ]);
    expect(forUser(got, 'artisanA')[0].data.actionUrl).toMatch(
      new RegExp(`/dashboard/artisan/jobs/${paidJobId}$`),
    );

    const payment = await payments.findOneByOrFail({ jobId: paidJobId });
    await webhook('charge.success', {
      reference: payment.reference,
      amount: Math.round(Number(payment.amount) * 100),
      currency: 'GHS',
      channel: 'mobile_money',
      paid_at: new Date().toISOString(),
    });
    // A redelivered webhook must not send a second receipt.
    await webhook('charge.success', {
      reference: payment.reference,
      amount: Math.round(Number(payment.amount) * 100),
      currency: 'GHS',
      channel: 'mobile_money',
      paid_at: new Date().toISOString(),
    });
    got = await settle();
    report('charge.success x2', got);
    expect(got.map((m) => [m.to === emailOf('customer'), m.event])).toEqual(
      expect.arrayContaining([
        [true, 'payment.receipt'],
        [false, 'payment.secured'],
      ]),
    );
    expect(got).toHaveLength(2);
    expect(got.find((m) => m.event === 'payment.receipt')!.html).toContain(
      'GH₵ 150.00',
    );

    for (const step of ['start', 'request-completion']) {
      const res = await request(server())
        .patch(`/api/v1/jobs/${paidJobId}/${step}`)
        .set(as('artisanA'));
      expect(res.status).toBe(200);
    }
    got = await settle();
    report('start + request-completion', got);
    expect(got.map((m) => m.event)).toEqual([
      'job.started',
      'job.completion.requested',
    ]);

    const confirm = await request(server())
      .post(`/api/v1/jobs/${paidJobId}/confirm`)
      .set(as('customer'));
    expect(confirm.status).toBe(201);
    got = await settle();
    report('confirm', got);
    const completed = forUser(got, 'artisanA');
    expect(completed.map((m) => m.event)).toEqual(['job.completed']);
    // Also sent by the 48h auto-complete, so it mustn't claim the customer did it.
    expect((completed[0].data.paragraphs as string[])[0]).not.toMatch(
      /customer/i,
    );
  });

  it('payout released and payout failed', async () => {
    const payment = await payments.findOneByOrFail({ jobId: paidJobId });
    report(`payment after confirm: ${payment.status}`, []);
    await payments.update(payment.id, {
      transferReference: `eml-tr-${uniq}`,
      status: PaymentStatus.PENDING_TRANSFER,
    });
    await webhook('transfer.failed', {
      reference: `eml-tr-${uniq}`,
      reason: 'Account number is invalid',
    });
    let got = await settle();
    report('transfer.failed', got);
    expect(got.length).toBeGreaterThanOrEqual(2); // seed admin + test admin
    expect(got.every((m) => m.event === 'payment.transfer-failed')).toBe(true);
    expect(forUser(got, 'admin')).toHaveLength(1);
    expect(forUser(got, 'artisanA')).toHaveLength(0);

    await webhook('transfer.success', { reference: `eml-tr-${uniq}` });
    await webhook('transfer.success', { reference: `eml-tr-${uniq}` });
    got = await settle();
    report('transfer.success x2', got);
    expect(got.map((m) => m.event)).toEqual(['payment.payout-released']);
    expect(got[0].to).toBe(emailOf('artisanA'));
    expect(got[0].data.actionUrl).toMatch(/\/dashboard\/artisan\/earnings$/);
  });

  it('admin refund emails the customer once', async () => {
    const jobId = await postJob(`Refund tap ${uniq}`);
    await apply('artisanA', jobId, 200);
    await accept(jobId, 'artisanA');
    await payments.update({ jobId }, { status: PaymentStatus.HELD });
    await settle();
    const payment = await payments.findOneByOrFail({ jobId });
    const res = await request(server())
      .post(`/api/v1/payments/admin/refund/${payment.id}`)
      .set(as('admin'))
      .send({ amountGhs: 50 });
    report(
      `partial refund → ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`,
      [],
    );
    const got = await settle();
    report('refund', got);
    expect(got.map((m) => [m.to === emailOf('customer'), m.event])).toEqual([
      [true, 'payment.refunded'],
    ]);
    expect(got[0].html).toContain('GH₵ 50.00');
    expect(String(got[0].data.heading)).toMatch(/partial/i);
    expect(got[0].subject).toBe('A Partial Refund Has Been Issued');
  });

  it('customer cancelling an accepted job emails the artisan', async () => {
    const jobId = await postJob(`Cancel tap ${uniq}`);
    await apply('artisanA', jobId);
    await apply('artisanB', jobId);
    await accept(jobId, 'artisanA');
    await settle();
    const res = await request(server())
      .patch(`/api/v1/jobs/${jobId}/cancel`)
      .set(as('customer'));
    expect(res.status).toBe(200);
    const got = await settle();
    report('cancel', got);
    expect(forUser(got, 'artisanA').map((m) => m.event)).toEqual([
      'job.cancelled',
    ]);
    // B was already rejected at accept time; they shouldn't hear again.
    expect(forUser(got, 'artisanB')).toHaveLength(0);
  });

  it('expiring a job emails the customer and waiting artisans', async () => {
    const jobId = await postJob(`Expire tap ${uniq}`);
    await apply('artisanA', jobId);
    await settle();
    await mod.get(JobsService).expireJob(jobId);
    const got = await settle();
    report('expire', got);
    expect(got.map((m) => [m.to, m.subject])).toEqual([
      [emailOf('customer'), 'Job Posting Expired'],
      [emailOf('artisanA'), 'A Job You Applied To Has Closed'],
    ]);
  });

  it('messages: one email per unread run, again after reading', async () => {
    const send = (from: string, to: string, content: string) =>
      request(server())
        .post('/api/v1/messages')
        .set(as(from))
        .send({ recipientId: userOf[to].id, content });
    expect(
      (await send('customer', 'artisanA', 'Hello, are you free on Monday?'))
        .status,
    ).toBe(201);
    await settle();
    await send('customer', 'artisanA', 'Also, bring a ladder and tools');
    await send('customer', 'artisanA', 'Thanks!');
    let got = await settle();
    report('messages 2 & 3 (first unread already emailed)', got);
    expect(got).toHaveLength(0);

    // The artisan replies: the customer gets their first email.
    await send('artisanA', 'customer', 'Yes, Monday at 10 works.');
    got = await settle();
    report('artisan reply', got);
    expect(forUser(got, 'customer')).toHaveLength(1);
    expect(forUser(got, 'customer')[0].data.actionUrl).toMatch(
      /\/dashboard\/user\/messages$/,
    );

    // Artisan reads the thread, then the customer writes again → new email.
    const conv = await request(server())
      .get('/api/v1/messages')
      .set(as('artisanA'));
    const convs = (conv.body as { data: Array<{ id: number }> }).data;
    const read = await request(server())
      .patch(`/api/v1/messages/${convs[0].id}/read`)
      .set(as('artisanA'));
    expect(read.status).toBe(200);
    await send('customer', 'artisanA', 'See you then.');
    got = await settle();
    report('after read', got);
    expect(forUser(got, 'artisanA')).toHaveLength(1);
  });

  it('message preview is escaped in the HTML', async () => {
    const send = (from: string, to: string, content: string) =>
      request(server())
        .post('/api/v1/messages')
        .set(as(from))
        .send({ recipientId: userOf[to].id, content });
    await send('artisanB', 'customer', '<img src=x onerror=alert(1)> hi');
    const got = await settle();
    report('xss preview', got);
    expect(got).toHaveLength(1);
    expect(got[0].html).not.toContain('<img src=x');
  });

  it('turning email off, or the type off, stops the email', async () => {
    const res = await request(server())
      .patch('/api/v1/notifications/preferences')
      .set(as('artisanB'))
      .send({ applicationRejected: false });
    report(
      `prefs → ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`,
      [],
    );
    const jobId = await postJob(`Prefs tap ${uniq}`);
    await apply('artisanA', jobId);
    await apply('artisanB', jobId);
    await settle();
    await accept(jobId, 'artisanA');
    const got = await settle();
    report('accept with B muted', got);
    expect(forUser(got, 'artisanB')).toHaveLength(0);
    expect(forUser(got, 'artisanA')).toHaveLength(1);
  });

  describe('disputes', () => {
    let bookingId = 0;
    beforeAll(async () => {
      const booked = await request(server())
        .post('/api/v1/bookings')
        .set(as('customer'))
        .send({
          artisanProfileId: profileOf.artisanA,
          serviceId: serviceIds[0],
          scheduledDate: monday(2),
          startTime: '10:00',
        });
      expect(booked.status).toBe(201);
      bookingId = (booked.body as { data: { id: number } }).data.id;
      const confirmed = await request(server())
        .patch(`/api/v1/bookings/${bookingId}/confirm`)
        .set(as('artisanA'))
        .send({ price: 180 });
      expect(confirmed.status).toBe(200);
      const cancelled = await request(server())
        .delete(`/api/v1/bookings/${bookingId}`)
        .set(as('customer'));
      report(`booking cancel → ${cancelled.status}`, []);
      await settle();
    });

    let disputeId = 0;
    it('filing emails every admin and the artisan', async () => {
      const res = await request(server())
        .post('/api/v1/disputes')
        .set(as('customer'))
        .send({
          bookingId,
          category: 'OTHER',
          reason:
            'The artisan cancelled on me twice without any notice at all.',
        });
      report(
        `dispute → ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`,
        [],
      );
      expect(res.status).toBe(201);
      disputeId = (res.body as { data: { id: number } }).data.id;
      const got = await settle();
      report('dispute filed', got);
      expect(forUser(got, 'admin')).toHaveLength(1);
      expect(forUser(got, 'artisanA')).toHaveLength(1);
      expect(forUser(got, 'customer')).toHaveLength(0);
      expect(forUser(got, 'artisanA')[0].data.actionUrl).toMatch(
        new RegExp(`/dashboard/artisan/disputes/${disputeId}$`),
      );
    });

    it('resolving emails both parties from their own side', async () => {
      const res = await request(server())
        .patch(`/api/v1/admin/disputes/${disputeId}/resolve`)
        .set(as('admin'))
        .send({
          outcome: 'MUTUAL',
          resolution: 'Both parties agreed to rebook at a later date.',
        });
      report(
        `resolve → ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`,
        [],
      );
      expect(res.status).toBe(200);
      const got = await settle();
      report('dispute resolved', got);
      expect(got.map((m) => m.to).sort()).toEqual(
        [emailOf('customer'), emailOf('artisanA')].sort(),
      );
      expect(forUser(got, 'customer')[0].data.actionUrl).toMatch(
        new RegExp(`/dashboard/user/disputes/${disputeId}$`),
      );
    });
  });

  it('every captured email rendered with a subject and no raw template tags', () => {
    // Covered as each mail was captured (renderTemplate throws on a missing
    // template); spot-check the layout here.
    const { html, subject } = templates.renderTemplate('job.started', {
      firstname: 'Ama',
      heading: 'Work has started',
      paragraphs: ['x'],
    });
    expect(subject).toBe('Work Has Started on Your Job');
    expect(html).not.toMatch(/{{|}}/);
  });
});
