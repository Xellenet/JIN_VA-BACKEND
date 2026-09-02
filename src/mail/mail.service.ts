import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailProviderFactory } from './providers/mail-provider.factory';
import { MailTemplateService } from './mail.template';
import { getErrorMessage } from '@common/utils/error.util';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly templates: MailTemplateService,
    /**
     * BI4: the transport is now chosen by `MAIL_PROVIDER` (generic SMTP by
     * default, Resend when opted in) instead of a nodemailer transporter
     * built directly in this constructor. Everything below the seam —
     * templates, subjects, the plain-text derivation, and the log-and-re-throw
     * failure behaviour — is deliberately unchanged.
     */
    private readonly providers: MailProviderFactory,
  ) {}

  async sendMail(
    to: string,
    eventType: string,
    data: Record<string, any>,
  ): Promise<void> {
    const from = this.config.get<string>('MAIL_FROM');
    // Kept outside the try block, as before: a missing template is a
    // programming error, not a delivery failure, and must not be reported as
    // "failed to send mail".
    const { subject, html } = this.templates.renderTemplate(eventType, data);

    try {
      await this.providers.getProvider().send({
        from,
        to,
        subject,
        html,
        text: html.replace(/<[^>]*>?/gm, ''),
      });

      this.logger.log(`✅ Mail sent to ${to} [${eventType}]`);
    } catch (err) {
      this.logger.error(
        `❌ Failed to send mail to ${to}: ${getErrorMessage(err)}`,
      );
      throw err;
    }
  }
}
