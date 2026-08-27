import { ConfigService } from '@nestjs/config';
import { SmtpMailProvider } from './smtp-mail.provider';
import type { MailMessage } from './mail-provider.interface';

/**
 * BI4: the incumbent SMTP transport behind the new seam. These assertions
 * exist to prove BI4 changed nothing for an environment that has not set
 * `MAIL_PROVIDER` — same nodemailer transport options, same `sendMail`
 * payload, same propagated failure.
 */

interface TransportOptions {
  host?: string;
  port?: number;
  secure?: boolean;
  auth?: { user?: string; pass?: string };
}

const sendMailMock = jest.fn();
const createTransportMock = jest.fn<
  { sendMail: typeof sendMailMock },
  [TransportOptions]
>(() => ({ sendMail: sendMailMock }));

jest.mock('nodemailer', () => ({
  createTransport: (options: TransportOptions) => createTransportMock(options),
}));

const MESSAGE: MailMessage = {
  from: 'JinVa <no-reply@jinva.test>',
  to: 'client@example.test',
  subject: 'Password Reset Instructions',
  html: '<p>Reset your password</p>',
  text: 'Reset your password',
};

const buildProvider = (env: Record<string, string | undefined>) =>
  new SmtpMailProvider({
    get: <T>(key: string): T | undefined => env[key] as T | undefined,
  } as ConfigService);

const CONFIGURED = {
  MAIL_HOST: 'smtp.example.test',
  MAIL_PORT: '587',
  MAIL_USER: 'placeholder-user',
  MAIL_PASS: 'placeholder-pass',
  MAIL_FROM: MESSAGE.from,
};

describe('SmtpMailProvider (BI4)', () => {
  beforeEach(() => {
    sendMailMock.mockReset();
    createTransportMock.mockClear();
  });

  it('is the provider named "smtp"', () => {
    expect(buildProvider(CONFIGURED).providerName).toBe('smtp');
  });

  it('sends the rendered message through nodemailer unchanged', async () => {
    sendMailMock.mockResolvedValueOnce({ messageId: '1' });

    await buildProvider(CONFIGURED).send(MESSAGE);

    expect(sendMailMock).toHaveBeenCalledWith({
      from: MESSAGE.from,
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      text: MESSAGE.text,
    });
  });

  it('builds the transport from the same MAIL_* variables as before', async () => {
    sendMailMock.mockResolvedValueOnce({ messageId: '1' });

    await buildProvider(CONFIGURED).send(MESSAGE);

    expect(createTransportMock).toHaveBeenCalledWith({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      auth: { user: 'placeholder-user', pass: 'placeholder-pass' },
    });
  });

  it('still treats port 465 as implicit TLS', async () => {
    sendMailMock.mockResolvedValueOnce({ messageId: '1' });

    await buildProvider({ ...CONFIGURED, MAIL_PORT: '465' }).send(MESSAGE);

    expect(createTransportMock.mock.calls[0][0]).toMatchObject({
      port: 465,
      secure: true,
    });
  });

  it('builds the transport lazily and only once', async () => {
    sendMailMock.mockResolvedValue({ messageId: '1' });
    const provider = buildProvider(CONFIGURED);

    expect(createTransportMock).not.toHaveBeenCalled();
    await provider.send(MESSAGE);
    await provider.send(MESSAGE);
    expect(createTransportMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a send failure rather than swallowing it', async () => {
    sendMailMock.mockRejectedValueOnce(new Error('535 auth failed'));

    await expect(buildProvider(CONFIGURED).send(MESSAGE)).rejects.toThrow(
      /SMTP transport rejected the message/,
    );
  });

  /**
   * The default transport must not put the configured `MAIL_USER` value into
   * the application log. `MailService` logs whatever message this provider
   * throws, so the assertion that matters is on the thrown string.
   */
  describe('failure sanitisation', () => {
    /** What nodemailer actually produces for an SMTP 535 auth rejection. */
    const authRejection = Object.assign(
      new Error(
        'Invalid login: 535 5.7.8 Authentication credentials invalid for user leak-sentinel-not-a-key',
      ),
      {
        code: 'EAUTH',
        responseCode: 535,
        response:
          '535 5.7.8 Authentication credentials invalid for user leak-sentinel-not-a-key',
        command: 'AUTH PLAIN',
      },
    );

    it('reports the nodemailer code and SMTP status, so an operator can still diagnose it', async () => {
      sendMailMock.mockRejectedValueOnce(authRejection);

      await expect(buildProvider(CONFIGURED).send(MESSAGE)).rejects.toThrow(
        /EAUTH \/ SMTP 535/,
      );
    });

    it('never echoes the username the server reflected back, in any field', async () => {
      sendMailMock.mockRejectedValueOnce(authRejection);

      const thrown = await buildProvider(CONFIGURED)
        .send(MESSAGE)
        .then(
          () => null,
          (err: unknown) => err,
        );

      const message = (thrown as Error).message;
      expect(message).not.toContain('leak-sentinel-not-a-key');
      expect(message).not.toContain('Invalid login');
      expect(message).not.toContain('5.7.8');
      expect(message).not.toContain(CONFIGURED.MAIL_USER);
      expect(message).not.toContain(CONFIGURED.MAIL_PASS);
    });

    it('still throws — a sanitised failure is not a swallowed one', async () => {
      sendMailMock.mockRejectedValueOnce(authRejection);

      await expect(
        buildProvider(CONFIGURED).send(MESSAGE),
      ).rejects.toBeInstanceOf(Error);
    });

    it('falls back to the error name when nodemailer classified nothing', async () => {
      sendMailMock.mockRejectedValueOnce(
        Object.assign(new Error('socket hang up leak-sentinel-not-a-key'), {
          name: 'TypeError',
        }),
      );

      const thrown = await buildProvider(CONFIGURED)
        .send(MESSAGE)
        .then(
          () => null,
          (err: unknown) => err,
        );

      expect((thrown as Error).message).toContain('TypeError');
      expect((thrown as Error).message).not.toContain('leak-sentinel');
      expect((thrown as Error).message).not.toContain('socket hang up');
    });

    it('reports a connection failure distinguishably from an auth failure', async () => {
      sendMailMock.mockRejectedValueOnce(
        Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:587'), {
          code: 'ECONNECTION',
        }),
      );

      const thrown = await buildProvider(CONFIGURED)
        .send(MESSAGE)
        .then(
          () => null,
          (err: unknown) => err,
        );

      expect((thrown as Error).message).toContain('ECONNECTION');
      expect((thrown as Error).message).not.toContain('10.0.0.5');
    });
  });

  describe('missingConfiguration()', () => {
    it('reports nothing when host and sender are set', () => {
      expect(buildProvider(CONFIGURED).missingConfiguration()).toEqual([]);
    });

    it('reports MAIL_HOST and MAIL_FROM by name when absent', () => {
      expect(buildProvider({}).missingConfiguration()).toEqual([
        'MAIL_HOST',
        'MAIL_FROM',
      ]);
    });

    it('does NOT require MAIL_USER / MAIL_PASS, so an unauthenticated relay keeps working', () => {
      expect(
        buildProvider({
          MAIL_HOST: CONFIGURED.MAIL_HOST,
          MAIL_FROM: CONFIGURED.MAIL_FROM,
        }).missingConfiguration(),
      ).toEqual([]);
    });
  });
});
