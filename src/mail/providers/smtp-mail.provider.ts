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
 */
@Injectable()
export class SmtpMailProvider implements IMailProvider {
  readonly providerName = 'smtp';
  private transporter: Transporter | undefined;

  constructor(private readonly config: ConfigService) {}

  async send(message: MailMessage): Promise<void> {
    await this.getTransporter().sendMail({
      from: message.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
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
