import { UserMailListener } from './user-mail.listener';
import { DomainMailListener } from './domain-mail.listener';
import { MailEvent } from '../events/mail.events';
import { DisputeMoneyAction, DisputeOutcome, Role } from '@common/types/enums';
import { APP_EVENTS } from '@common/events/app.events';
import type {
  BookingConfirmedPayload,
  BookingReceivedPayload,
  DisputeOutcomePayload,
} from '@common/events/app.events';
import { MailTemplateService } from '../mail.template';

/** QA NOT-09: gaps found in the account and booking emails. */
const config = {
  get: jest.fn((key: string, fallback?: unknown) =>
    key === 'FRONTEND_URL' ? 'https://app.jinva.example' : fallback,
  ),
};

describe('UserMailListener (QA NOT-09)', () => {
  const mailService = { sendMail: jest.fn(() => Promise.resolve()) };
  const listener = new UserMailListener(mailService as never, config as never);
  beforeEach(() => mailService.sendMail.mockClear());

  it.each([
    [
      'password reset success',
      () =>
        listener.handlePasswordResetSuccess({
          email: 'a@example.com',
          firstname: 'Ama',
        }),
    ],
    [
      'password changed',
      () =>
        listener.handlePasswordChanged({
          email: 'a@example.com',
          firstname: 'Ama',
        }),
    ],
    [
      'welcome',
      () =>
        listener.handleUserVerified({
          email: 'a@example.com',
          firstname: 'Ama',
        }),
    ],
  ])('gives the %s email a real login link', async (_label, send) => {
    await send();
    const [[, , context]] = mailService.sendMail.mock.calls as unknown as [
      [string, string, { loginLink?: string }],
    ];
    expect(context.loginLink).toBe('https://app.jinva.example/login');
  });

  it('logs a mail failure instead of leaving an unhandled rejection', async () => {
    mailService.sendMail.mockRejectedValueOnce(new Error('SMTP down'));
    await expect(
      listener.handlePasswordChanged({
        email: 'a@example.com',
        firstname: 'Ama',
      }),
    ).resolves.toBeUndefined();
    expect(mailService.sendMail).toHaveBeenCalledWith(
      'a@example.com',
      MailEvent.PASSWORD_CHANGED,
      expect.anything(),
    );
  });
});

describe('DomainMailListener preferences (QA NOT-09)', () => {
  function build(prefs: Record<string, unknown> | null) {
    const mailService = { sendMail: jest.fn(() => Promise.resolve()) };
    const usersRepository = {
      findOne: jest.fn(() =>
        Promise.resolve({ email: 'u@example.com', firstname: 'Yaw' }),
      ),
    };
    const prefsRepository = { findOne: jest.fn(() => Promise.resolve(prefs)) };
    const listener = new DomainMailListener(
      mailService as never,
      config as never,
      usersRepository as never,
      prefsRepository as never,
      {} as never,
    );
    return { listener, mailService };
  }
  const received = {
    artisanUserId: 20,
    customerName: 'Ama Mensah',
    scheduledDate: '2027-01-04',
    bookingId: 7,
  } as BookingReceivedPayload;
  const confirmed = {
    customerId: 42,
    artisanName: 'Yaw Osei',
    scheduledDate: '2027-01-04',
    bookingId: 7,
  } as BookingConfirmedPayload;

  it('sends when the person has no preferences saved yet', async () => {
    const { listener, mailService } = build(null);
    await listener.handleBookingReceived(received);
    expect(mailService.sendMail).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when email is switched off', async () => {
    const { listener, mailService } = build({
      emailEnabled: false,
      user: { role: Role.ARTISAN },
    });
    await listener.handleBookingReceived(received);
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });

  it("respects the event's own toggle", async () => {
    const { listener, mailService } = build({
      emailEnabled: true,
      bookingConfirmed: false,
      user: { role: Role.CUSTOMER },
    });
    await listener.handleBookingConfirmed(confirmed);
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });
});

describe('DomainMailListener job, message, payment and dispute emails', () => {
  type Sent = [string, string, Record<string, unknown>];
  const people: Record<
    number,
    { email: string; firstname: string; role: Role }
  > = {
    1: { email: 'ama@example.com', firstname: 'Ama', role: Role.CUSTOMER },
    2: { email: 'yaw@example.com', firstname: 'Yaw', role: Role.ARTISAN },
    3: { email: 'kofi@example.com', firstname: 'Kofi', role: Role.ARTISAN },
    9: { email: 'admin@example.com', firstname: 'Esi', role: Role.ADMIN },
  };

  function build(
    opts: {
      prefs?: Record<number, Record<string, unknown>>;
      unread?: number;
    } = {},
  ) {
    const mailService = { sendMail: jest.fn(() => Promise.resolve()) };
    const usersRepository = {
      findOne: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve(people[where.id] ?? null),
      ),
      find: jest.fn(() => Promise.resolve([{ id: 9 }])),
    };
    const prefsRepository = {
      findOne: jest.fn(({ where }: { where: { user: { id: number } } }) => {
        const p = opts.prefs?.[where.user.id];
        return Promise.resolve(
          p ? { emailEnabled: true, user: people[where.user.id], ...p } : null,
        );
      }),
    };
    const messagesRepository = {
      count: jest.fn(() => Promise.resolve(opts.unread ?? 1)),
    };
    const listener = new DomainMailListener(
      mailService as never,
      config as never,
      usersRepository as never,
      prefsRepository as never,
      messagesRepository as never,
    );
    const sent = () => mailService.sendMail.mock.calls as unknown as Sent[];
    return { listener, mailService, sent };
  }

  it('emails the customer about a new application, linking to their job', async () => {
    const { listener, sent } = build();
    await listener.handleJobApplicationReceived({
      customerId: 1,
      artisanName: 'Yaw Osei',
      jobTitle: 'Fix kitchen sink',
      jobId: 12,
    });
    const [[to, event, data]] = sent();
    expect(to).toBe('ama@example.com');
    expect(event).toBe(APP_EVENTS.JOB_APPLICATION_RECEIVED);
    expect(data.actionUrl).toBe(
      'https://app.jinva.example/dashboard/user/jobs/12',
    );
    expect((data.paragraphs as string[])[0]).toContain('Yaw Osei');
  });

  it('links an artisan into the artisan dashboard', async () => {
    const { listener, sent } = build();
    await listener.handleJobCompleted({
      artisanId: 2,
      jobTitle: 'Fix kitchen sink',
      jobId: 12,
    });
    expect(sent()[0][2].actionUrl).toBe(
      'https://app.jinva.example/dashboard/artisan/jobs/12',
    );
  });

  it('emails the customer and every artisan still waiting when a job expires', async () => {
    const { listener, sent } = build();
    await listener.handleJobExpired({
      customerId: 1,
      jobTitle: 'Paint bedroom',
      jobId: 5,
      pendingArtisanIds: [2, 3],
    });
    expect(sent().map(([to]) => to)).toEqual([
      'ama@example.com',
      'yaw@example.com',
      'kofi@example.com',
    ]);
  });

  it("respects the recipient's toggle for the event", async () => {
    const { listener, mailService } = build({
      prefs: { 2: { applicationRejected: false } },
    });
    await listener.handleJobApplicationRejected({
      artisanId: 2,
      jobTitle: 'Paint bedroom',
      jobId: 5,
    });
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });

  it('sends nothing when the recipient switched email off', async () => {
    const { listener, mailService } = build({
      prefs: { 1: { emailEnabled: false } },
    });
    await listener.handlePaymentReceipt({
      customerId: 1,
      jobId: 12,
      jobTitle: 'Fix kitchen sink',
      amount: 250,
      reference: 'JV-REF-1',
    });
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });

  describe('messages', () => {
    const message = {
      recipientId: 1,
      senderName: 'Yaw Osei',
      preview: 'I can come on Monday',
      conversationId: 4,
    };

    it('emails the first unread message of a conversation', async () => {
      const { listener, sent } = build({ unread: 1 });
      await listener.handleMessageReceived(message);
      const [[, event, data]] = sent();
      expect(event).toBe(APP_EVENTS.MESSAGE_RECEIVED);
      expect(data.quote).toBe('I can come on Monday');
      expect(data.actionUrl).toBe(
        'https://app.jinva.example/dashboard/user/messages',
      );
    });

    it('does not email again while earlier messages are still unread', async () => {
      const { listener, mailService } = build({ unread: 3 });
      await listener.handleMessageReceived(message);
      expect(mailService.sendMail).not.toHaveBeenCalled();
    });
  });

  it('includes the amount and reference on the payment receipt', async () => {
    const { listener, sent } = build();
    await listener.handlePaymentReceipt({
      customerId: 1,
      jobId: 12,
      jobTitle: 'Fix kitchen sink',
      amount: 1850,
      reference: 'JV-REF-1',
    });
    expect(sent()[0][2].details).toEqual(
      expect.arrayContaining([
        { label: 'Amount Paid', value: 'GH₵ 1,850.00' },
        { label: 'Payment Reference', value: 'JV-REF-1' },
      ]),
    );
  });

  it("sends failed payouts to admins, gated by each admin's toggle", async () => {
    const payload = {
      paymentId: 3,
      jobId: 12,
      jobTitle: 'Fix kitchen sink',
      artisanName: 'Yaw Osei',
      artisanAmount: 200,
      reason: 'Invalid account number',
    };
    const on = build();
    await on.listener.handlePaymentTransferFailed(payload);
    expect(on.sent().map(([to]) => to)).toEqual(['admin@example.com']);

    const off = build({ prefs: { 9: { paymentTransferFailed: false } } });
    await off.listener.handlePaymentTransferFailed(payload);
    expect(off.mailService.sendMail).not.toHaveBeenCalled();
  });

  it('tells admins and the other party about a new dispute', async () => {
    const { listener, sent } = build();
    await listener.handleDisputeFiled({
      disputeId: 8,
      bookingId: 6,
      raisedByName: 'Ama Mensah',
      raisedByRole: Role.CUSTOMER,
      counterpartyUserId: 2,
    });
    const calls = sent();
    expect(calls.map(([to]) => to)).toEqual([
      'admin@example.com',
      'yaw@example.com',
    ]);
    expect(calls[1][2].actionUrl).toBe(
      'https://app.jinva.example/dashboard/artisan/disputes/8',
    );
  });

  it("writes each side's dispute outcome from their own point of view", async () => {
    const { listener, sent } = build();
    const payload: DisputeOutcomePayload = {
      disputeId: 8,
      bookingId: 6,
      raisedByUserId: 1,
      counterpartyUserId: 2,
      outcome: 'RESOLVED',
      verdict: DisputeOutcome.REFUND_CLIENT,
      moneyAction: DisputeMoneyAction.REFUND,
      moneyAmount: 100,
      customerUserId: 1,
      artisanUserId: 2,
    };
    await listener.handleDisputeResolved(payload);
    const [customer, artisan] = sent().map(
      ([, , data]) => data.paragraphs as string[],
    );
    expect(customer).toContain(
      'Refunded to you: GH₵ 100.00. It should reach your original payment method shortly.',
    );
    expect(artisan).toContain('GH₵ 100.00 was refunded to the client.');
  });

  it('logs a mail failure instead of throwing', async () => {
    const { listener, mailService } = build();
    mailService.sendMail.mockRejectedValueOnce(new Error('SMTP down'));
    await expect(
      listener.handleJobStarted({ customerId: 1, jobTitle: 'X', jobId: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe('activity-notice template', () => {
  const templates = new MailTemplateService();

  it('renders the copy, details and button with its own subject', () => {
    const { subject, html } = templates.renderTemplate(
      APP_EVENTS.PAYMENT_RECEIPT,
      {
        firstname: 'Ama',
        heading: 'Payment received',
        paragraphs: ['We have received your payment.'],
        details: [{ label: 'Amount Paid', value: 'GH₵ 250.00' }],
        actionUrl: 'https://app.jinva.example/dashboard/user/jobs/12',
        actionLabel: 'View Job',
        appName: 'JinVa',
        year: 2026,
        supportEmail: 'support@example.com',
      },
    );
    expect(subject).toBe('Payment Receipt');
    expect(html).toContain('Payment received');
    expect(html).toContain('GH₵ 250.00');
    expect(html).toContain(
      'href="https://app.jinva.example/dashboard/user/jobs/12"',
    );
  });

  it('escapes what users typed, such as a message preview', () => {
    const { html } = templates.renderTemplate(APP_EVENTS.MESSAGE_RECEIVED, {
      firstname: 'Ama',
      heading: 'New message',
      paragraphs: [],
      quote: '<script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
