import { ConfigService } from '@nestjs/config';
import { ResendMailProvider } from './resend-mail.provider';
import type { MailMessage } from './mail-provider.interface';

/**
 * BI4: the Resend transport. The trap this pins down is the SDK's return
 * shape — `emails.send()` resolves with `{ data: null, error }` on an
 * API-level rejection instead of throwing, so a provider that only awaited it
 * would report success for every unsent verification and password-reset
 * email. `MailService`'s log-and-re-throw depends on this provider throwing.
 */

const sendMock = jest.fn();
const resendConstructor = jest.fn();

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation((key: string) => {
    resendConstructor(key);
    return { emails: { send: sendMock } };
  }),
}));

const MESSAGE: MailMessage = {
  from: 'JinVa <no-reply@jinva.test>',
  to: 'artisan@example.test',
  subject: 'Welcome to JinVa!',
  html: '<p>Verify your email</p>',
  text: 'Verify your email',
};

const buildProvider = (env: Record<string, string | undefined>) =>
  new ResendMailProvider({
    get: <T>(key: string): T | undefined => env[key] as T | undefined,
  } as ConfigService);

describe('ResendMailProvider (BI4)', () => {
  beforeEach(() => {
    sendMock.mockReset();
    resendConstructor.mockReset();
  });

  describe('missingConfiguration()', () => {
    it('reports nothing when the api key and sender are both set', () => {
      const provider = buildProvider({
        RESEND_API_KEY: 'placeholder-not-a-real-key',
        MAIL_FROM: MESSAGE.from,
      });
      expect(provider.missingConfiguration()).toEqual([]);
    });

    it('reports both required variables by name when neither is set', () => {
      expect(buildProvider({}).missingConfiguration()).toEqual([
        'RESEND_API_KEY',
        'MAIL_FROM',
      ]);
    });

    it('treats a whitespace-only api key as unset', () => {
      expect(
        buildProvider({
          RESEND_API_KEY: '   ',
          MAIL_FROM: MESSAGE.from,
        }).missingConfiguration(),
      ).toEqual(['RESEND_API_KEY']);
    });
  });

  describe('send()', () => {
    const configured = {
      RESEND_API_KEY: 'placeholder-not-a-real-key',
      MAIL_FROM: MESSAGE.from,
    };

    it('passes the rendered message straight through, template untouched', async () => {
      sendMock.mockResolvedValueOnce({ data: { id: 'abc' }, error: null });

      await buildProvider(configured).send(MESSAGE);

      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock).toHaveBeenCalledWith({
        from: MESSAGE.from,
        to: MESSAGE.to,
        subject: MESSAGE.subject,
        html: MESSAGE.html,
        text: MESSAGE.text,
      });
    });

    it('resolves without throwing on a successful send', async () => {
      sendMock.mockResolvedValueOnce({ data: { id: 'abc' }, error: null });
      await expect(
        buildProvider(configured).send(MESSAGE),
      ).resolves.toBeUndefined();
    });

    it('THROWS when the SDK resolves with an error, instead of reporting a phantom success', async () => {
      sendMock.mockResolvedValueOnce({
        data: null,
        error: { name: 'validation_error', statusCode: 403, message: 'nope' },
      });

      await expect(buildProvider(configured).send(MESSAGE)).rejects.toThrow(
        /Resend rejected the message: validation_error \(HTTP 403\)/,
      );
    });

    it('does not echo Resend’s free-text detail into the thrown message', async () => {
      sendMock.mockResolvedValueOnce({
        data: null,
        error: {
          name: 'invalid_api_key',
          statusCode: 401,
          message: 'API key leak-sentinel-not-a-key is invalid',
        },
      });

      await expect(buildProvider(configured).send(MESSAGE)).rejects.not.toThrow(
        /leak-sentinel-not-a-key/,
      );
    });

    it('re-throws a transport-level rejection (network failure) untouched', async () => {
      sendMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      await expect(buildProvider(configured).send(MESSAGE)).rejects.toThrow(
        /ECONNRESET/,
      );
    });

    it('fails with the variable name when RESEND_API_KEY is missing, and never contacts Resend', async () => {
      await expect(
        buildProvider({ MAIL_FROM: MESSAGE.from }).send(MESSAGE),
      ).rejects.toThrow(
        /RESEND_API_KEY is not configured.*MAIL_PROVIDER="resend"/,
      );
      expect(sendMock).not.toHaveBeenCalled();
      expect(resendConstructor).not.toHaveBeenCalled();
    });

    it('fails with the variable name when the sender address is missing', async () => {
      await expect(
        buildProvider(configured).send({ ...MESSAGE, from: undefined }),
      ).rejects.toThrow(/MAIL_FROM is not configured/);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('builds the client once and reuses it across sends', async () => {
      sendMock.mockResolvedValue({ data: { id: 'abc' }, error: null });
      const provider = buildProvider(configured);

      await provider.send(MESSAGE);
      await provider.send(MESSAGE);

      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(resendConstructor).toHaveBeenCalledTimes(1);
    });
  });
});
