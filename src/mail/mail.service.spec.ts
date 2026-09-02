import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import { MailTemplateService } from './mail.template';
import { MailProviderFactory } from './providers/mail-provider.factory';
import type { IMailProvider } from './providers/mail-provider.interface';

/**
 * BI4: `MailService` after the transport seam went in. These assertions are
 * the "nothing else changed" guard — the requirements doc is explicit that a
 * mail-provider migration must not alter templates, must keep logging and
 * re-throwing send failures, and must leave the verification/reset flows
 * behaving exactly as they do today.
 */
describe('MailService (BI4)', () => {
  const RENDERED = {
    subject: 'Password Reset Instructions',
    html: '<p>Hello <b>Ama</b>, reset your password</p>',
  };

  let provider: IMailProvider;
  let templates: MailTemplateService;
  let service: MailService;

  const build = (env: Record<string, string | undefined> = {}) => {
    provider = {
      providerName: 'stub',
      send: jest.fn().mockResolvedValue(undefined),
      missingConfiguration: jest.fn(() => []),
    };
    templates = {
      renderTemplate: jest.fn(() => RENDERED),
    } as unknown as MailTemplateService;
    const config = {
      get: <T>(key: string): T | undefined => env[key] as T | undefined,
    } as ConfigService;
    const factory = {
      getProvider: jest.fn(() => provider),
    } as unknown as MailProviderFactory;

    service = new MailService(config, templates, factory);
    return { factory };
  };

  it('renders the template for the event and hands the result to the active provider', async () => {
    build({ MAIL_FROM: 'JinVa <no-reply@jinva.test>' });

    await service.sendMail('ama@example.test', 'user.password-reset', {
      firstname: 'Ama',
    });

    expect(templates.renderTemplate).toHaveBeenCalledWith(
      'user.password-reset',
      { firstname: 'Ama' },
    );
    expect(provider.send).toHaveBeenCalledWith({
      from: 'JinVa <no-reply@jinva.test>',
      to: 'ama@example.test',
      subject: RENDERED.subject,
      html: RENDERED.html,
      text: 'Hello Ama, reset your password',
    });
  });

  it('derives the plain-text part by stripping tags, exactly as before', async () => {
    build();

    await service.sendMail('ama@example.test', 'user.password-reset', {});

    const sendSpy = provider.send as jest.Mock<
      Promise<void>,
      [{ text: string; html: string }]
    >;
    const sent = sendSpy.mock.calls[0][0];
    expect(sent.text).toBe(RENDERED.html.replace(/<[^>]*>?/gm, ''));
    // The HTML body itself — i.e. the template output — is passed untouched.
    expect(sent.html).toBe(RENDERED.html);
  });

  it('asks the factory for the provider on every send, so MAIL_PROVIDER is honoured without a restart-order dependency', async () => {
    const { factory } = build();

    await service.sendMail('a@example.test', 'user.welcome', {});
    await service.sendMail('b@example.test', 'user.welcome', {});

    expect(factory.getProvider).toHaveBeenCalledTimes(2);
  });

  it('logs and re-throws a send failure rather than swallowing it', async () => {
    build();
    (provider.send as jest.Mock).mockRejectedValueOnce(
      new Error('transport exploded'),
    );
    const errorSpy = jest
      .spyOn(service['logger'], 'error')
      .mockImplementation(() => undefined);

    await expect(
      service.sendMail('ama@example.test', 'user.password-reset', {}),
    ).rejects.toThrow(/transport exploded/);

    expect(String(errorSpy.mock.calls[0][0])).toContain(
      'Failed to send mail to ama@example.test',
    );
    errorSpy.mockRestore();
  });

  it('does not report a missing template as a delivery failure', async () => {
    build();
    (templates.renderTemplate as jest.Mock).mockImplementationOnce(() => {
      throw new Error('Email template missing for event: nope');
    });
    const errorSpy = jest
      .spyOn(service['logger'], 'error')
      .mockImplementation(() => undefined);

    await expect(
      service.sendMail('ama@example.test', 'nope', {}),
    ).rejects.toThrow(/Email template missing/);

    expect(provider.send).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('logs a success line naming the recipient and event', async () => {
    build();
    const logSpy = jest
      .spyOn(service['logger'], 'log')
      .mockImplementation(() => undefined);

    await service.sendMail('ama@example.test', 'user.welcome', {});

    expect(String(logSpy.mock.calls[0][0])).toContain('ama@example.test');
    expect(String(logSpy.mock.calls[0][0])).toContain('user.welcome');
    logSpy.mockRestore();
  });
});
