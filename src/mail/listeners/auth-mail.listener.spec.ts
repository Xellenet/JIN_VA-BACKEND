import type { ConfigService } from '@nestjs/config';
import { MailEvent } from '../events/mail.events';
import type { MailService } from '../mail.service';
import { MailTemplateService } from '../mail.template';
import { AuthMailListener, formatInstant } from './auth-mail.listener';

describe('AuthMailListener (auth v2 emails)', () => {
  const values: Record<string, string> = {
    FRONTEND_URL: 'https://app.jinva.test',
    APP_NAME: 'JinVa',
    SUPPORT_EMAIL: 'support@jinva.test',
  };
  const config = {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  } as unknown as ConfigService;
  const templates = new MailTemplateService();
  let sent: Array<{
    to: string;
    event: string;
    subject: string;
    html: string;
    data: Record<string, unknown>;
  }>;
  let mail: { sendMail: jest.Mock };
  let listener: AuthMailListener;

  beforeEach(() => {
    sent = [];
    mail = {
      sendMail: jest.fn(
        (to: string, event: string, data: Record<string, unknown>) => {
          const { subject, html } = templates.renderTemplate(event, data);
          sent.push({ to, event, subject, html, data });
          return Promise.resolve();
        },
      ),
    };
    listener = new AuthMailListener(mail as unknown as MailService, config);
  });

  it('"Your JinVa code": the code shown large, 10 minutes, staff never ask, and no link carrying it', async () => {
    await listener.handleCode({
      email: 'kofi.asante@example.com',
      firstname: 'Kofi',
      code: '048291',
      kind: 'signup',
      expiresInMinutes: 10,
    });
    const [m] = sent;
    expect(m.event).toBe(MailEvent.AUTH_CODE);
    expect(m.subject).toBe('Your JinVa code');
    expect(m.html).toContain('048291');
    expect(m.html).toMatch(/font-size:38px[^>]*>048291</);
    expect(m.html).toContain('10 minutes');
    expect(m.html).toContain('JinVa staff will never ask for this code');
    expect(m.html).toContain('Confirm your email');
    // No sign-in link: no anchor at all except the support mailto in the footer.
    const hrefs = [...m.html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]);
    expect(hrefs.every((h) => h.startsWith('mailto:'))).toBe(true);
    expect(hrefs.join(' ')).not.toContain('048291');
  });

  it.each([
    ['login', 'Your sign-in code'],
    ['password_reset', 'Reset your password'],
  ] as const)('words a %s code for its purpose', async (kind, heading) => {
    await listener.handleCode({
      email: 'e@example.com',
      firstname: 'E',
      code: '111111',
      kind,
      expiresInMinutes: 10,
    });
    expect(sent[0].html).toContain(heading);
  });

  it('"Someone tried to sign up with your address": no code, links to log in and reset', async () => {
    await listener.handleSignupAttempt({
      email: 'kofi.asante@example.com',
      firstname: 'Kofi',
    });
    const [m] = sent;
    expect(m.subject).toBe('Someone tried to sign up with your address');
    expect(m.html).toContain('https://app.jinva.test/login');
    expect(m.html).toContain('https://app.jinva.test/forgot-password');
    expect(m.html).not.toMatch(/>\s*\d{6}\s*</);
    expect(m.html).not.toContain('{{code}}');
  });

  it('"New sign-in to your JinVa account": time, device, method and a secure-my-account link', async () => {
    await listener.handleNewSignIn({
      email: 'kofi.asante@example.com',
      firstname: 'Kofi',
      signedInAt: new Date('2026-11-03T14:05:00Z'),
      device: 'Chrome on Windows',
      method: 'code',
    });
    const [m] = sent;
    expect(m.subject).toBe('New sign-in to your JinVa account');
    expect(m.html).toContain('3 November 2026, 14:05 UTC');
    expect(m.html).toContain('Chrome on Windows');
    expect(m.html).toContain('Email code');
    expect(m.html).toContain('Secure my account');
    expect(m.html).toContain('href="https://app.jinva.test/forgot-password"');
  });

  it('"Your password was changed": when, and a secure-my-account link', async () => {
    await listener.handlePasswordChanged({
      email: 'kofi.asante@example.com',
      firstname: 'Kofi',
      changedAt: new Date('2026-11-03T09:30:00Z'),
    });
    const [m] = sent;
    expect(m.subject).toBe('Your password was changed');
    expect(m.html).toContain('3 November 2026, 09:30 UTC');
    expect(m.html).toContain('href="https://app.jinva.test/forgot-password"');
  });

  it('logs a delivery failure without the address or the code, and never throws', async () => {
    mail.sendMail.mockRejectedValueOnce(new Error('smtp down'));
    const error = jest
      .spyOn(listener['logger'], 'error')
      .mockImplementation(() => undefined);
    await expect(
      listener.handleCode({
        email: 'kofi.asante@example.com',
        firstname: 'K',
        code: '777777',
        kind: 'login',
        expiresInMinutes: 10,
      }),
    ).resolves.toBeUndefined();
    const logged = error.mock.calls.map((c) => String(c[0])).join(' ');
    expect(logged).not.toContain('kofi.asante');
    expect(logged).not.toContain('777777');
  });

  it('formats instants in UTC', () => {
    expect(formatInstant(new Date('2026-01-02T03:04:00Z'))).toBe(
      '2 January 2026, 03:04 UTC',
    );
  });
});
