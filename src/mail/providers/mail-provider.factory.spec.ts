import { ConfigService } from '@nestjs/config';
import { MailProviderFactory } from './mail-provider.factory';
import type { IMailProvider } from './mail-provider.interface';

/**
 * BI4: provider selection. The single most important property is that an
 * environment which has never heard of `MAIL_PROVIDER` keeps the SMTP
 * transport it has today — this touches verification and password-reset mail,
 * so a wrong default silently stops people being able to sign up or recover
 * an account.
 */
describe('MailProviderFactory (BI4)', () => {
  const stub = (providerName: string, missing: string[] = []): IMailProvider =>
    ({
      providerName,
      send: jest.fn(),
      missingConfiguration: jest.fn(() => missing),
    }) as IMailProvider;

  const build = (
    env: Record<string, string | undefined>,
    smtp: IMailProvider = stub('smtp'),
    resend: IMailProvider = stub('resend'),
  ) => {
    const config = {
      get: <T>(key: string): T | undefined => env[key] as T | undefined,
    } as ConfigService;
    return new MailProviderFactory(config, smtp as never, resend as never);
  };

  describe('getProvider()', () => {
    it('defaults to SMTP when MAIL_PROVIDER is unset, so nothing breaks for an environment that has not adopted it', () => {
      expect(build({}).getProvider().providerName).toBe('smtp');
    });

    it('returns the Resend provider when MAIL_PROVIDER is "resend"', () => {
      expect(
        build({ MAIL_PROVIDER: 'resend' }).getProvider().providerName,
      ).toBe('resend');
    });

    it('tolerates casing and surrounding whitespace on the variable', () => {
      expect(
        build({ MAIL_PROVIDER: '  Resend  ' }).getProvider().providerName,
      ).toBe('resend');
      expect(build({ MAIL_PROVIDER: 'SMTP' }).getProvider().providerName).toBe(
        'smtp',
      );
    });

    it('treats an empty value as unset rather than as an unknown provider', () => {
      const factory = build({ MAIL_PROVIDER: '   ' });
      const warnSpy = jest
        .spyOn(factory['logger'], 'warn')
        .mockImplementation(() => undefined);

      expect(factory.getProvider().providerName).toBe('smtp');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('warns and falls back to SMTP for an unrecognised value instead of failing to send anything', () => {
      const factory = build({ MAIL_PROVIDER: 'sendgrid' });
      const warnSpy = jest
        .spyOn(factory['logger'], 'warn')
        .mockImplementation(() => undefined);

      expect(factory.getProvider().providerName).toBe('smtp');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('MAIL_PROVIDER');
      // The offending value must not be echoed back into the log.
      expect(String(warnSpy.mock.calls[0][0])).not.toContain('sendgrid');
      warnSpy.mockRestore();
    });
  });

  describe('onModuleInit()', () => {
    it('logs missing variables for the active provider by name', () => {
      const factory = build(
        { MAIL_PROVIDER: 'resend' },
        stub('smtp'),
        stub('resend', ['RESEND_API_KEY', 'MAIL_FROM']),
      );
      const errorSpy = jest
        .spyOn(factory['logger'], 'error')
        .mockImplementation(() => undefined);

      factory.onModuleInit();

      const message = String(errorSpy.mock.calls[0][0]);
      expect(message).toContain('RESEND_API_KEY');
      expect(message).toContain('MAIL_FROM');
      errorSpy.mockRestore();
    });

    it('says nothing about the inactive provider', () => {
      const factory = build(
        {},
        stub('smtp'),
        stub('resend', ['RESEND_API_KEY']),
      );
      const errorSpy = jest
        .spyOn(factory['logger'], 'error')
        .mockImplementation(() => undefined);
      const logSpy = jest
        .spyOn(factory['logger'], 'log')
        .mockImplementation(() => undefined);

      factory.onModuleInit();

      expect(errorSpy).not.toHaveBeenCalled();
      expect(String(logSpy.mock.calls[0][0])).toContain('smtp');
      errorSpy.mockRestore();
      logSpy.mockRestore();
    });
  });
});
