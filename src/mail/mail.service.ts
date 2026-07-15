import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransporter } from './mail.config';
import { MailTemplateService } from './mail.template';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: any;

  constructor(
    private readonly config: ConfigService,
    private readonly templates: MailTemplateService,
  ) {
    this.transporter = createTransporter(config);
  }

  async sendMail(to: string, eventType: string, data: Record<string, any>) {
    const from = this.config.get('MAIL_FROM');
    const { subject, html } = this.templates.renderTemplate(eventType, data);

    try {
      const info = await this.transporter.sendMail({
        from,
        to,
        subject,
        html,
        text: html.replace(/<[^>]*>?/gm, ''),
      });

      this.logger.log(`✅ Mail sent to ${to} [${eventType}]`);
      return info;
    } catch (err) {
      this.logger.error(`❌ Failed to send mail to ${to}: ${err.message}`);
      throw err;
    }
  }
}
