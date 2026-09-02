/**
 * BI4: the transport seam for transactional email, deliberately shaped like
 * `IStorageProvider` in `src/uploads/providers/storage-provider.interface.ts`
 * — an interface plus a factory that selects an implementation from a single
 * environment variable (`MAIL_PROVIDER`, mirroring `STORAGE_PROVIDER`).
 *
 * What this seam is *not* allowed to change: templates, subjects, the
 * plain-text derivation, or the fact that a send failure is logged and
 * re-thrown by `MailService`. Providers only move bytes.
 */

/** One rendered message, ready to hand to a transport. */
export interface MailMessage {
  /**
   * `MAIL_FROM`. Optional in the type because `MailService` has always passed
   * it straight through from configuration without asserting it — providers
   * report it via {@link IMailProvider.missingConfiguration} instead of the
   * shape pretending it is guaranteed.
   */
  from: string | undefined;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface IMailProvider {
  readonly providerName: string;

  /**
   * Sends the message, or throws. Throwing is the contract: `MailService`
   * logs and re-throws, exactly as it did with the raw nodemailer transport,
   * so a provider must never swallow a rejection and report success.
   */
  send(message: MailMessage): Promise<void>;

  /**
   * The **names** (never the values) of the environment variables this
   * provider needs but cannot find. Empty means the provider is usable.
   * `MailProviderFactory` logs this once at boot so a half-finished provider
   * migration is visible immediately rather than at the first verification
   * email.
   */
  missingConfiguration(): string[];
}
