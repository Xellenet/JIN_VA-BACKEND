import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

/**
 * BI4: unchanged. This is now `SmtpMailProvider`'s transport builder rather
 * than something `MailService` calls directly — kept byte-for-byte so the
 * default (`MAIL_PROVIDER` unset) path behaves exactly as it did before the
 * provider abstraction landed. See `providers/mail-provider.interface.ts`.
 */
export const createTransporter = (config: ConfigService) => {
  return nodemailer.createTransport({
    host: config.get('MAIL_HOST'),
    port: Number(config.get('MAIL_PORT')) || 587,
    secure: Number(config.get('MAIL_PORT')) === 465,
    auth: {
      user: config.get('MAIL_USER'),
      pass: config.get('MAIL_PASS'),
    },
  });
};
