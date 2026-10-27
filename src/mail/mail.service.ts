import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailProviderFactory } from './providers/mail-provider.factory';
import { MailTemplateService } from './mail.template';
import { getErrorMessage } from '@common/utils/error.util';
import { hashEmailForLog } from '@common/utils/log-identifier.util';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  mdash: '—',
  ndash: '–',
};

/**
 * The plain-text part is the HTML with its tags stripped, which left
 * Handlebars' escaping behind ("We&#x27;ve", "&quot;Fix tap&quot;"). Decodes
 * the entities so the text reads as written. Runs after the tags are gone, so
 * a decoded "<" can't turn back into markup.
 */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (entity: string, code: string) => {
      if (code[0] === '#') {
        const n =
          code[1] === 'x' || code[1] === 'X'
            ? parseInt(code.slice(2), 16)
            : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n <= 0x10ffff
          ? String.fromCodePoint(n)
          : entity;
      }
      return NAMED_ENTITIES[code.toLowerCase()] ?? entity;
    },
  );
}

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
        text: decodeEntities(html.replace(/<[^>]*>?/gm, '')),
      });

      // PR6: the recipient is logged as its hash, never in plaintext.
      this.logger.log(
        `✅ Mail sent to email hash ${hashEmailForLog(to)} [${eventType}]`,
      );
    } catch (err) {
      this.logger.error(
        `❌ Failed to send mail to email hash ${hashEmailForLog(to)}: ${getErrorMessage(err)}`,
      );
      throw err;
    }
  }
}
