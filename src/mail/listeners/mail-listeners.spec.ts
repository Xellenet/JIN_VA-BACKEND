import { UserMailListener } from './user-mail.listener';
import { DomainMailListener } from './domain-mail.listener';
import { MailEvent } from '../events/mail.events';
import { Role } from '@common/types/enums';
import type {
  BookingConfirmedPayload,
  BookingReceivedPayload,
} from '@common/events/app.events';

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
