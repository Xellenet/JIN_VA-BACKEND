import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { IMailProvider, MailMessage } from './mail-provider.interface';

/**
 * BI4: Resend-backed implementation of {@link IMailProvider}, the PRD §7
 * named provider JinVa is migrating to (Open Question 8's recorded decision:
 * the current SMTP host is *not* already SendGrid or Resend, so this is a real
 * migration rather than a paperwork closure).
 *
 * NOT active by default — `MailProviderFactory` only returns this provider
 * when `MAIL_PROVIDER === 'resend'`. Setting that variable, like the S3
 * cutover, is the operator's action; nothing in this codebase does it, and no
 * environment file is read, opened or inspected to build it.
 *
 * Configuration is read exclusively via named environment variables:
 * - `MAIL_PROVIDER`   set to `resend` to activate this provider (`smtp` or
 *                     unset keeps the existing SMTP transport)
 * - `RESEND_API_KEY`  (required when active) — the Resend API key, created in
 *                     the Resend dashboard. Never read or echoed by this
 *                     codebase; referenced by name only.
 * - `MAIL_FROM`       (required) — the sender address, which must be on a
 *                     domain verified in Resend or Resend rejects the send.
 *                     Supplied by `MailService`, unchanged.
 *
 * Explicitly *not* used: `MAIL_HOST` / `MAIL_PORT` / `MAIL_USER` /
 * `MAIL_PASS`. Those stay meaningful only for the SMTP provider, so the two
 * can coexist and an environment can switch back by unsetting one variable.
 *
 * Failure discipline. The SDK does **not** throw on an API-level rejection —
 * it resolves with `{ data: null, error }` — so a naive port would report
 * success for every unsent email and quietly break verification and password
 * reset. `send()` therefore inspects `error` and throws, which is what keeps
 * `MailService`'s existing "log and re-throw" behaviour intact. The thrown
 * message carries Resend's error *code* and HTTP status only: mail transports
 * are the one place an error string can pick up an authentication credential
 * (an SMTP `535` response echoes the username, for instance), and this string
 * lands in the application log. The per-message detail lives in Resend's
 * dashboard, which is the deliverability reporting BI4 exists to get.
 */
@Injectable()
export class ResendMailProvider implements IMailProvider {
  readonly providerName = 'resend';
  private client: Resend | undefined;

  constructor(private readonly config: ConfigService) {}

  async send(message: MailMessage): Promise<void> {
    const apiKey = this.requireApiKey();
    if (!message.from) {
      throw new Error(
        'MAIL_FROM is not configured. Resend requires a sender address on a domain verified in Resend.',
      );
    }

    const { error } = await this.getClient(apiKey).emails.send({
      from: message.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });

    if (error) {
      throw new Error(
        `Resend rejected the message: ${error.name}${
          error.statusCode ? ` (HTTP ${error.statusCode})` : ''
        }. See the Resend dashboard for the per-message detail.`,
      );
    }
  }

  missingConfiguration(): string[] {
    const missing: string[] = [];
    if (!this.readConfig('RESEND_API_KEY')) missing.push('RESEND_API_KEY');
    if (!this.readConfig('MAIL_FROM')) missing.push('MAIL_FROM');
    return missing;
  }

  private requireApiKey(): string {
    const apiKey = this.readConfig('RESEND_API_KEY');
    if (!apiKey) {
      // Named, not valued. Thrown rather than left to the SDK constructor,
      // whose own "Missing API key" error would otherwise fall back to
      // reading `process.env.RESEND_API_KEY` itself and produce a less
      // actionable message.
      throw new Error(
        'RESEND_API_KEY is not configured. Set it before running with MAIL_PROVIDER="resend".',
      );
    }
    return apiKey;
  }

  /** Built on first use, mirroring `S3StorageProvider.getClient`. */
  private getClient(apiKey: string): Resend {
    if (!this.client) {
      this.client = new Resend(apiKey);
    }
    return this.client;
  }

  /** Trims so a variable set to whitespace counts as unset. */
  private readConfig(name: string): string | undefined {
    const trimmed = this.config.get<string>(name)?.trim();
    return trimmed ? trimmed : undefined;
  }
}
