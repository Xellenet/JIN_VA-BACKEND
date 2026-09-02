import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Transporter } from 'nodemailer';
import { createTransporter } from '../mail.config';
import type { IMailProvider, MailMessage } from './mail-provider.interface';

/**
 * BI4: the pre-existing generic SMTP transport, moved behind
 * {@link IMailProvider} without changing a single thing about how it sends.
 *
 * This is the **default** provider — `MailProviderFactory` selects it whenever
 * `MAIL_PROVIDER` is unset — so an environment that has not adopted the new
 * variable keeps behaving exactly as it did before this abstraction existed.
 *
 * Configuration is read by name only, via `mail.config.ts`'s existing
 * `createTransporter`, which is untouched:
 * - `MAIL_HOST` (required when active)
 * - `MAIL_PORT` (optional — defaults to 587; 465 implies TLS)
 * - `MAIL_USER` / `MAIL_PASS` (passed through to nodemailer as before)
 * - `MAIL_FROM` (required — supplied by `MailService`, not read here)
 *
 * Failure discipline — the one thing about sending that *did* change. This
 * used to `await sendMail()` with no catch, so nodemailer's raw error
 * propagated to `MailService`, which logs `getErrorMessage(err)`. nodemailer
 * surfaces an SMTP auth rejection as `Invalid login: <verbatim server
 * response>`, and many servers echo the submitted username in their `535`
 * response — so the `MAIL_USER` value could land in the application log. That
 * is the risk `ResendMailProvider` was written to avoid, and this is the
 * **default, currently-active** transport, so it needs the same treatment.
 * `send()` therefore catches, and re-throws using nodemailer's `code` and
 * `responseCode` only — never `err.message` and never `err.response`. The
 * thrown message is what `MailService` logs, so that log line is now provably
 * credential-free too. Nothing else changes: it still throws on failure, so
 * the existing log-and-re-throw contract is intact.
 */
@Injectable()
export class SmtpMailProvider implements IMailProvider {
  readonly providerName = 'smtp';
  private transporter: Transporter | undefined;

  constructor(private readonly config: ConfigService) {}

  async send(message: MailMessage): Promise<void> {
    try {
      await this.getTransporter().sendMail({
        from: message.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
    } catch (err) {
      throw new Error(
        `The SMTP transport rejected the message: ${describeSmtpFailure(err)}. ` +
          `The server's own response is deliberately not repeated here or in the log, ` +
          `because an SMTP 535 echoes the submitted MAIL_USER value; read it from the mail server's logs.`,
      );
    }
  }

  missingConfiguration(): string[] {
    const missing: string[] = [];
    // Without a host nodemailer silently targets localhost:587, where nothing
    // is listening — the classic "verification emails just never arrive".
    if (!this.readConfig('MAIL_HOST')) missing.push('MAIL_HOST');
    // Every provider needs a sender; `MailService` reads it, but this is the
    // only place that can report it missing before the first send.
    if (!this.readConfig('MAIL_FROM')) missing.push('MAIL_FROM');
    // MAIL_USER / MAIL_PASS are deliberately not required: they were never
    // asserted before, and requiring them now would break an unauthenticated
    // relay that works today.
    return missing;
  }

  /**
   * Built on first use rather than in the constructor. Under the old code the
   * transport was created eagerly in `MailService`'s constructor, so an
   * unreachable or misconfigured SMTP host was a boot-time concern even for
   * requests that send no mail; deferring it also means selecting the Resend
   * provider never constructs an SMTP transport at all.
   */
  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = createTransporter(this.config);
    }
    return this.transporter;
  }

  /** Trims so a variable set to whitespace counts as unset. */
  private readConfig(name: string): string | undefined {
    const trimmed = this.config.get<string>(name)?.trim();
    return trimmed ? trimmed : undefined;
  }
}

/**
 * Describes a nodemailer failure using only enumerable, non-free-text fields —
 * the mirror image of `describeAwsFailure` in `S3StorageProvider`:
 * - `code`         nodemailer's own classification (`EAUTH`, `ECONNECTION`,
 *                  `ETIMEDOUT`, `EENVELOPE`, `EMESSAGE`, `ESOCKET`, …)
 * - `responseCode` the SMTP status number (535, 550, 421, …)
 *
 * Deliberately excluded: `err.message` (which embeds `Invalid login: <server
 * response>`) and `err.response` (the verbatim server line). Between them,
 * `code` and `responseCode` are enough to tell an auth rejection from a
 * connection failure from a rejected recipient, which is what an operator
 * actually needs from the app log; the full server response is in the mail
 * server's own logs.
 */
function describeSmtpFailure(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  const responseCode = (err as { responseCode?: unknown })?.responseCode;

  const parts: string[] = [];
  if (typeof code === 'string' && code) parts.push(code);
  if (typeof responseCode === 'number') parts.push(`SMTP ${responseCode}`);
  if (parts.length === 0) {
    // No classification at all (e.g. a plain `new Error()` from a stubbed
    // transport). The error *name* is safe — it is a class name, not text
    // built from the server's reply.
    parts.push(err instanceof Error && err.name ? err.name : 'UnknownError');
  }
  return parts.join(' / ');
}
