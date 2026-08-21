import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Transporter } from 'nodemailer';
import { createTransporter } from './mail.config';
import { MailTemplateService } from './mail.template';
import { getErrorMessage } from '@common/utils/error.util';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter;

  constructor(
    private readonly config: ConfigService,
    private readonly templates: MailTemplateService,
  ) {
    this.transporter = createTransporter(config);
  }

  async sendMail(
    to: string,
    eventType: string,
    data: Record<string, any>,
  ): Promise<void> {
    const from = this.config.get<string>('MAIL_FROM');
    const { subject, html } = this.templates.renderTemplate(eventType, data);

    try {
      await this.transporter.sendMail({
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
