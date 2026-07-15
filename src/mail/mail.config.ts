import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

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
