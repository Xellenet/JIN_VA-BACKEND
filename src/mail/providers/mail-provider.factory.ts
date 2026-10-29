import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResendMailProvider } from './resend-mail.provider';
import { SmtpMailProvider } from './smtp-mail.provider';
import type { IMailProvider } from './mail-provider.interface';

/**
 * BI4: selects the transactional email transport, mirroring
 * `StorageProviderFactory` one-for-one — same constructor-injected providers,
 * same `getProvider()` switch, same "unset means the incumbent" default, same
 * boot-time configuration check.
 *
 * The one intentional difference from `StorageProviderFactory` is that the
 * variable is read through `ConfigService` rather than `process.env`, because
 * that is the mail module's existing convention (`MailService`,
 * `UserMailListener` and `mail.config.ts` all read configuration that way).
 * `ConfigService` falls through to `process.env`, so `MAIL_PROVIDER` behaves
 * as a plain environment variable either way.
 */
@Injectable()
export class MailProviderFactory implements OnModuleInit {
  private readonly logger = new Logger(MailProviderFactory.name);

  constructor(
    private readonly config: ConfigService,
    private readonly smtpProvider: SmtpMailProvider,
    private readonly resendProvider: ResendMailProvider,
  ) {}

  /**
   * Returns the active mail provider based on `MAIL_PROVIDER`. Generic SMTP
   * remains the default, so an environment that has not set the new variable
   * is completely unaffected by BI4.
   */
  getProvider(): IMailProvider {
    const providerName = this.config.get<string>('MAIL_PROVIDER') ?? 'smtp';
    switch (providerName.trim().toLowerCase()) {
      case 'resend':
        return this.resendProvider;
      case 'smtp':
      case '':
        return this.smtpProvider;
      default:
        // Loud but non-fatal: a typo in the variable must not stop the app
        // from sending mail at all, and silently falling back would hide the
        // fact that the intended provider is not the one in use.
        this.logger.warn(
          `Unrecognised MAIL_PROVIDER value — falling back to "smtp". Supported values: "smtp", "resend".`,
        );
        return this.smtpProvider;
    }
  }

  /**
   * Reports the selected transport and any configuration it is missing, by
   * variable **name** only. Never fatal: verification and password-reset mail
   * is dispatched through the event emitter, so a mail misconfiguration must
   * not be able to take the API down.
   */
  onModuleInit(): void {
    const provider = this.getProvider();
    const missing = provider.missingConfiguration();

    if (missing.length > 0) {
      this.logger.error(
        `Mail provider "${provider.providerName}" is selected but misconfigured — ` +
          `missing environment variables: ${missing.join(', ')}. ` +
          `Verification, password-reset and notification emails will fail to send until these are set.`,
      );
      return;
    }

    this.logger.log(`Mail provider "${provider.providerName}" is active.`);
  }
}
