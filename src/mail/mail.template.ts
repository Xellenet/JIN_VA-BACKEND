import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as Handlebars from 'handlebars';
import { APP_EVENTS } from '@common/events/app.events';

/**
 * Job, message, payment and dispute emails share one layout: their copy (a
 * heading, a few paragraphs, a details box and a button) is written by
 * `DomainMailListener`, so they render through `activity-notice.hbs` rather
 * than one near-identical template each.
 */
const ACTIVITY_SUBJECTS: Record<string, string> = {
  [APP_EVENTS.JOB_APPLICATION_RECEIVED]: 'New Application for Your Job',
  [APP_EVENTS.JOB_APPLICATION_ACCEPTED]: 'Your Application Was Accepted',
  [APP_EVENTS.JOB_APPLICATION_REJECTED]: 'Update on Your Job Application',
  [APP_EVENTS.JOB_STARTED]: 'Work Has Started on Your Job',
  [APP_EVENTS.JOB_COMPLETION_REQUESTED]: 'Please Confirm Your Job Is Complete',
  [APP_EVENTS.JOB_COMPLETED]: 'Job Confirmed Complete',
  [APP_EVENTS.JOB_CANCELLED]: 'Job Cancelled',
  [APP_EVENTS.JOB_EXPIRED]: 'Job Posting Expired',
  [APP_EVENTS.MESSAGE_RECEIVED]: 'You Have a New Message',
  [APP_EVENTS.PAYMENT_RECEIPT]: 'Payment Receipt',
  [APP_EVENTS.PAYMENT_SECURED]: 'Payment Secured for Your Job',
  [APP_EVENTS.PAYOUT_RELEASED]: 'Your Payout Has Been Released',
  [APP_EVENTS.PAYMENT_REFUNDED]: 'Your Refund Has Been Issued',
  [APP_EVENTS.PAYMENT_TRANSFER_FAILED]: 'Payout Transfer Failed',
  [APP_EVENTS.DISPUTE_FILED]: 'A Dispute Has Been Filed',
  [APP_EVENTS.DISPUTE_RESOLVED]: 'Your Dispute Has Been Resolved',
  [APP_EVENTS.DISPUTE_CLOSED]: 'Your Dispute Has Been Closed',
};

@Injectable()
export class MailTemplateService {
  private readonly logger = new Logger(MailTemplateService.name);
  private readonly cache = new Map<string, Handlebars.TemplateDelegate>();

  renderTemplate(eventType: string, data: Record<string, any>) {
    const name =
      eventType in ACTIVITY_SUBJECTS
        ? 'activity-notice'
        : eventType.replace(/\./g, '-'); // e.g. artisan.profile.verified → artisan-profile-verified
    const templatePath = fs.existsSync(
      path.join(__dirname, 'templates', `${name}.hbs`),
    )
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
    // An activity email can word its subject for this recipient (an artisan
    // whose application closed isn't told "Job Posting Expired").
    const subject =
      typeof data.subject === 'string' && data.subject
        ? data.subject
        : this.subjectForEvent(eventType);

    return { subject, html };
  }

  private subjectForEvent(eventType: string): string {
    if (eventType in ACTIVITY_SUBJECTS) return ACTIVITY_SUBJECTS[eventType];
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
      case 'user.account-deleted':
        return 'Your JinVa Account Has Been Deleted';
      case 'user.account-restored':
        return 'Your JinVa Account Has Been Restored';
      case 'artisan.profile.verified':
        return 'Your Identity Has Been Verified';
      case 'artisan.verification.rejected':
        return 'Verification Submission Update';
      case 'booking.received':
        return 'New Booking Request';
      case 'booking.confirmed':
        return 'Booking Confirmed';
      case 'booking.declined':
        return 'Booking Declined';
      case 'booking.cancelled':
        return 'Booking Cancelled';
      case 'booking.completed':
        return 'Booking Marked as Completed';
      case 'booking.expired':
        return 'Booking Request Expired';
      case 'booking.no-show':
        return 'No-Show Reported';
      case 'booking.reminder.24h':
        return 'Reminder: Appointment Tomorrow';
      case 'booking.reminder.2h':
        return 'Reminder: Appointment in 2 Hours';
      default:
        return 'Notification from JinVa';
    }
  }
}
