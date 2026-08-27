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
      /535 auth failed/,
    );
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
