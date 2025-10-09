import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as Handlebars from 'handlebars';

@Injectable()
export class MailTemplateService {
  private readonly logger = new Logger(MailTemplateService.name);
  private readonly cache = new Map<string, Handlebars.TemplateDelegate>();

  renderTemplate(eventType: string, data: Record<string, any>) {
    const name = eventType.replace('.', '-'); // e.g. user.registered → user-registered
    const templatePath =
    fs.existsSync(path.join(__dirname, 'templates', `${name}.hbs`))
        ? path.join(__dirname, 'templates', `${name}.hbs`)
        : path.join(process.cwd(), 'src', 'mail', 'templates', `${name}.hbs`);

    let templateFn = this.cache.get(name);

    if (!templateFn) {
      if (!fs.existsSync(templatePath)) {
        this.logger.error(`Template file not found: ${templatePath}`);
        throw new Error(`Email template missing for event: ${eventType}`);
      }

      const templateContent = fs.readFileSync(templatePath, 'utf-8');
      templateFn = Handlebars.compile(templateContent);
      this.cache.set(name, templateFn);
      this.logger.log(`Loaded email template: ${name}`);
    }

    const html = templateFn(data);
    const subject = this.subjectForEvent(eventType);

    return { subject, html };
  }

  private subjectForEvent(eventType: string): string {
    switch (eventType) {
      case 'user.registered':
        return 'Welcome to JinVa!';
      case 'order.placed':
        return 'Your Order Confirmation';
      case 'user.welcome':
        return 'Your account has been verified!';
      case 'user.password-reset':
        return 'Password Reset Instructions';
      case 'user.password-reset-success':
        return 'Your Password Has Been Reset';
      case 'user.password-changed':
        return 'Your Password Has Been Changed';
      default:
        return 'Notification from JinVa';
    }
  }
}
