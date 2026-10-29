import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../mail.service';
import { APP_EVENTS } from '@common/events/app.events';
import { getErrorMessage } from '@common/utils/error.util';
import { NotificationType, Role } from '@common/types/enums';
import { formatGhs } from '@common/utils/currency.util';
import {
  describeDisputeOutcome,
  preferenceKeyFor,
} from '../../notifications/notifications.service';
import { User } from '../../users/entities/user.entity';
import { NotificationPreferences } from '../../notifications/entities/notification-preferences.entity';
import { Message } from '../../messages/entities/message.entity';
import type {
  ArtisanProfileVerifiedPayload,
  ArtisanVerificationRejectedPayload,
  BookingReceivedPayload,
  BookingConfirmedPayload,
  BookingDeclinedPayload,
  BookingCancelledPayload,
  BookingCompletedPayload,
  BookingExpiredPayload,
  BookingNoShowPayload,
  BookingReminderPayload,
  JobApplicationReceivedPayload,
  JobApplicationAcceptedPayload,
  JobApplicationRejectedPayload,
  JobStartedPayload,
  JobCompletionRequestedPayload,
  JobCompletedPayload,
  JobCancelledPayload,
  JobExpiredPayload,
  MessageReceivedPayload,
  PaymentReceiptPayload,
  PaymentSecuredPayload,
  PayoutReleasedPayload,
  PaymentRefundedPayload,
  PaymentTransferFailedPayload,
  DisputeFiledPayload,
  DisputeOutcomePayload,
} from '@common/events/app.events';

type Recipient = { email: string; firstname: string; role: Role };

/** The copy of a job, message, payment or dispute email (activity-notice.hbs). */
interface ActivityEmail {
  /** Overrides the event's default subject, for this recipient only. */
  subject?: string;
  heading: string;
  paragraphs: string[];
  quote?: string;
  details?: Array<{ label: string; value: string | number }>;
  /** Path on the frontend, e.g. `/dashboard/user/jobs/12`. */
  actionPath?: string;
  actionLabel?: string;
}

/** The dashboard area each role's links point into. */
function dashboardFor(role: Role): string {
  if (role === Role.ARTISAN) return '/dashboard/artisan';
  if (role === Role.ADMIN) return '/dashboard/admin';
  return '/dashboard/user';
}

@Injectable()
export class DomainMailListener {
  private readonly logger = new Logger(DomainMailListener.name);

  constructor(
    private readonly mailService: MailService,
    private readonly config: ConfigService,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(NotificationPreferences)
    private readonly prefsRepository: Repository<NotificationPreferences>,
    @InjectRepository(Message)
    private readonly messagesRepository: Repository<Message>,
  ) {}

  private async findUser(userId: number): Promise<Recipient | null> {
    return this.usersRepository.findOne({
      where: { id: userId },
      select: ['email', 'firstname', 'role'],
    });
  }

  /**
   * A7 / QA NOT-09: whether this person wants this email. The same rules as
   * in-app notifications (`preferenceKeyFor`): all email off, or the type's
   * own toggle off, means no email. Reminders used to be the only emails that
   * checked; booking and verification emails went out regardless.
   */
  private async isEmailWanted(
    userId: number,
    type: NotificationType,
  ): Promise<boolean> {
    const prefs = await this.prefsRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user'],
    });
    if (!prefs) return true; // no record yet → defaults apply (enabled)
    if (!prefs.emailEnabled) return false;
    const key = prefs.user
      ? preferenceKeyFor(prefs.user.role, type)
      : undefined;
    return !key || prefs[key] !== false;
  }

  private get appName(): string {
    return this.config.get<string>('APP_NAME', 'JinVa');
  }

  private get year(): number {
    return new Date().getFullYear();
  }

  private get supportEmail(): string {
    return this.config.get<string>('SUPPORT_EMAIL', '');
  }

  private get dashboardUrl(): string {
    return `${this.config.get<string>('FRONTEND_URL', '')}/dashboard`;
  }

  @OnEvent(APP_EVENTS.ARTISAN_PROFILE_VERIFIED, { async: true })
  async handleArtisanVerified(
    payload: ArtisanProfileVerifiedPayload,
  ): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.artisanUserId,
          NotificationType.ARTISAN_PROFILE_VERIFIED,
        ))
      )
        return;
      const user = await this.findUser(payload.artisanUserId);
      if (!user) return;
      await this.mailService.sendMail(
        user.email,
        APP_EVENTS.ARTISAN_PROFILE_VERIFIED,
        {
          firstname: user.firstname,
          dashboardUrl: this.dashboardUrl,
          appName: this.appName,
          year: this.year,
          supportEmail: this.supportEmail,
        },
      );
    } catch (err) {
      this.logger.error(
        `Failed to send artisan verified email: ${getErrorMessage(err)}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.ARTISAN_VERIFICATION_REJECTED, { async: true })
  async handleVerificationRejected(
    payload: ArtisanVerificationRejectedPayload,
  ): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.artisanUserId,
          NotificationType.ARTISAN_VERIFICATION_REJECTED,
        ))
      )
        return;
      const user = await this.findUser(payload.artisanUserId);
      if (!user) return;
      await this.mailService.sendMail(
        user.email,
        APP_EVENTS.ARTISAN_VERIFICATION_REJECTED,
        {
          firstname: user.firstname,
          reason: payload.reason,
          appName: this.appName,
          year: this.year,
          supportEmail: this.supportEmail,
        },
      );
    } catch (err) {
      this.logger.error(
        `Failed to send verification rejected email: ${getErrorMessage(err)}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_RECEIVED, { async: true })
  async handleBookingReceived(payload: BookingReceivedPayload): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.artisanUserId,
          NotificationType.BOOKING_RECEIVED,
        ))
      )
        return;
      const user = await this.findUser(payload.artisanUserId);
      if (!user) return;
      await this.mailService.sendMail(user.email, APP_EVENTS.BOOKING_RECEIVED, {
        firstname: user.firstname,
        customerName: payload.customerName,
        scheduledDate: payload.scheduledDate,
        bookingId: payload.bookingId,
        dashboardUrl: this.dashboardUrl,
        appName: this.appName,
        year: this.year,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send booking received email: ${getErrorMessage(err)}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_CONFIRMED, { async: true })
  async handleBookingConfirmed(
    payload: BookingConfirmedPayload,
  ): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.customerId,
          NotificationType.BOOKING_CONFIRMED,
        ))
      )
        return;
      const user = await this.findUser(payload.customerId);
      if (!user) return;
      await this.mailService.sendMail(
        user.email,
        APP_EVENTS.BOOKING_CONFIRMED,
        {
          firstname: user.firstname,
          artisanName: payload.artisanName,
          scheduledDate: payload.scheduledDate,
          bookingId: payload.bookingId,
          dashboardUrl: this.dashboardUrl,
          appName: this.appName,
          year: this.year,
          supportEmail: this.supportEmail,
        },
      );
    } catch (err) {
      this.logger.error(
        `Failed to send booking confirmed email: ${getErrorMessage(err)}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_DECLINED, { async: true })
  async handleBookingDeclined(payload: BookingDeclinedPayload): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.customerId,
          NotificationType.BOOKING_DECLINED,
        ))
      )
        return;
      const user = await this.findUser(payload.customerId);
      if (!user) return;
      await this.mailService.sendMail(user.email, APP_EVENTS.BOOKING_DECLINED, {
        firstname: user.firstname,
        artisanName: payload.artisanName,
        scheduledDate: payload.scheduledDate,
        bookingId: payload.bookingId,
        dashboardUrl: this.dashboardUrl,
        appName: this.appName,
        year: this.year,
        supportEmail: this.supportEmail,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send booking declined email: ${getErrorMessage(err)}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_CANCELLED, { async: true })
  async handleBookingCancelled(
    payload: BookingCancelledPayload,
  ): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.artisanUserId,
          NotificationType.BOOKING_CANCELLED,
        ))
      )
        return;
      const user = await this.findUser(payload.artisanUserId);
      if (!user) return;
      await this.mailService.sendMail(
        user.email,
        APP_EVENTS.BOOKING_CANCELLED,
        {
          firstname: user.firstname,
          customerName: payload.customerName,
          scheduledDate: payload.scheduledDate,
          bookingId: payload.bookingId,
          appName: this.appName,
          year: this.year,
          supportEmail: this.supportEmail,
        },
      );
    } catch (err) {
      this.logger.error(
        `Failed to send booking cancelled email: ${getErrorMessage(err)}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_COMPLETED, { async: true })
  async handleBookingCompleted(
    payload: BookingCompletedPayload,
  ): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.artisanUserId,
          NotificationType.BOOKING_COMPLETED,
        ))
      )
        return;
      const user = await this.findUser(payload.artisanUserId);
      if (!user) return;
      await this.mailService.sendMail(
        user.email,
        APP_EVENTS.BOOKING_COMPLETED,
        {
          firstname: user.firstname,
          scheduledDate: payload.scheduledDate,
          bookingId: payload.bookingId,
          appName: this.appName,
          year: this.year,
          supportEmail: this.supportEmail,
        },
      );
    } catch (err) {
      this.logger.error(
        `Failed to send booking completed email: ${getErrorMessage(err)}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_EXPIRED, { async: true })
  async handleBookingExpired(payload: BookingExpiredPayload): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.customerId,
          NotificationType.BOOKING_EXPIRED,
        ))
      )
        return;
      const user = await this.findUser(payload.customerId);
      if (!user) return;
      await this.mailService.sendMail(user.email, APP_EVENTS.BOOKING_EXPIRED, {
        firstname: user.firstname,
        scheduledDate: payload.scheduledDate,
        bookingId: payload.bookingId,
        appName: this.appName,
        year: this.year,
        supportEmail: this.supportEmail,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send booking expired email: ${(err as Error).message}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_NO_SHOW, { async: true })
  async handleBookingNoShow(payload: BookingNoShowPayload): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.recipientUserId,
          NotificationType.BOOKING_NO_SHOW,
        ))
      )
        return;
      const user = await this.findUser(payload.recipientUserId);
      if (!user) return;
      await this.mailService.sendMail(user.email, APP_EVENTS.BOOKING_NO_SHOW, {
        firstname: user.firstname,
        flaggedByName: payload.flaggedByName,
        scheduledDate: payload.scheduledDate,
        bookingId: payload.bookingId,
        appName: this.appName,
        year: this.year,
        supportEmail: this.supportEmail,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send no-show email: ${(err as Error).message}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_REMINDER_24H, { async: true })
  async handleBookingReminder24h(
    payload: BookingReminderPayload,
  ): Promise<void> {
    await this.sendReminderEmail(payload);
  }

  @OnEvent(APP_EVENTS.BOOKING_REMINDER_2H, { async: true })
  async handleBookingReminder2h(
    payload: BookingReminderPayload,
  ): Promise<void> {
    await this.sendReminderEmail(payload);
  }

  private async sendReminderEmail(
    payload: BookingReminderPayload,
  ): Promise<void> {
    try {
      const enabled = await this.isEmailWanted(
        payload.recipientUserId,
        NotificationType.BOOKING_REMINDER,
      );
      if (!enabled) return;
      const user = await this.findUser(payload.recipientUserId);
      if (!user) return;
      const eventKey =
        payload.milestone === '24H'
          ? APP_EVENTS.BOOKING_REMINDER_24H
          : APP_EVENTS.BOOKING_REMINDER_2H;
      await this.mailService.sendMail(user.email, eventKey, {
        firstname: user.firstname,
        scheduledDate: payload.scheduledDate,
        startTime: payload.startTime.slice(0, 5),
        bookingId: payload.bookingId,
        hoursOut: payload.milestone === '24H' ? '24 hours' : '2 hours',
        appName: this.appName,
        year: this.year,
        supportEmail: this.supportEmail,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send ${payload.milestone} reminder email: ${(err as Error).message}`,
      );
    }
  }

  // ─── Jobs, messages, payments and disputes ─────────────────────────────────

  private get frontendUrl(): string {
    return this.config.get<string>('FRONTEND_URL', '');
  }

  /**
   * Sends one activity email to `userId`, if they want this type of email.
   * `build` gets the recipient so links can point into their own dashboard.
   * Never throws: these run after the domain change has been saved.
   */
  private async notify(
    userId: number,
    type: NotificationType,
    event: string,
    build: (recipient: Recipient) => ActivityEmail,
  ): Promise<void> {
    try {
      if (!(await this.isEmailWanted(userId, type))) return;
      const user = await this.findUser(userId);
      if (!user) return;
      const { actionPath, ...content } = build(user);
      await this.mailService.sendMail(user.email, event, {
        ...content,
        firstname: user.firstname,
        actionUrl: actionPath ? `${this.frontendUrl}${actionPath}` : undefined,
        appName: this.appName,
        year: this.year,
        supportEmail: this.supportEmail,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send ${event} email to user ${userId}: ${getErrorMessage(err)}`,
      );
    }
  }

  /** Admin-facing emails go to every admin, each gated by their own toggles. */
  private async notifyAdmins(
    type: NotificationType,
    event: string,
    content: ActivityEmail,
  ): Promise<void> {
    try {
      const admins = await this.usersRepository.find({
        where: { role: Role.ADMIN },
        select: ['id'],
      });
      for (const admin of admins) {
        await this.notify(admin.id, type, event, () => content);
      }
    } catch (err) {
      this.logger.error(
        `Failed to send ${event} email to admins: ${getErrorMessage(err)}`,
      );
    }
  }

  private jobLink(role: Role, jobId: number) {
    return {
      actionPath: `${dashboardFor(role)}/jobs/${jobId}`,
      actionLabel: 'View Job',
    };
  }

  @OnEvent(APP_EVENTS.JOB_APPLICATION_RECEIVED, { async: true })
  async handleJobApplicationReceived(
    payload: JobApplicationReceivedPayload,
  ): Promise<void> {
    await this.notify(
      payload.customerId,
      NotificationType.JOB_APPLICATION_RECEIVED,
      APP_EVENTS.JOB_APPLICATION_RECEIVED,
      (user) => ({
        heading: 'You have a new application',
        paragraphs: [
          `${payload.artisanName} has applied to your job "${payload.jobTitle}".`,
          'Review their profile and accept the application when you are ready.',
        ],
        actionPath: `${dashboardFor(user.role)}/jobs/${payload.jobId}`,
        actionLabel: 'Review Application',
      }),
    );
  }

  @OnEvent(APP_EVENTS.JOB_APPLICATION_ACCEPTED, { async: true })
  async handleJobApplicationAccepted(
    payload: JobApplicationAcceptedPayload,
  ): Promise<void> {
    await this.notify(
      payload.artisanId,
      NotificationType.JOB_APPLICATION_ACCEPTED,
      APP_EVENTS.JOB_APPLICATION_ACCEPTED,
      (user) => ({
        heading: 'Your application was accepted',
        paragraphs: [
          `Good news! Your application for "${payload.jobTitle}" was accepted.`,
          "You can start work once the customer's payment is secured. You'll be notified when it is.",
        ],
        ...this.jobLink(user.role, payload.jobId),
      }),
    );
  }

  @OnEvent(APP_EVENTS.JOB_APPLICATION_REJECTED, { async: true })
  async handleJobApplicationRejected(
    payload: JobApplicationRejectedPayload,
  ): Promise<void> {
    await this.notify(
      payload.artisanId,
      NotificationType.JOB_APPLICATION_REJECTED,
      APP_EVENTS.JOB_APPLICATION_REJECTED,
      (user) => ({
        heading: 'Your application was not selected',
        paragraphs: [
          `Your application for "${payload.jobTitle}" was not selected this time.`,
          'New jobs are posted every day. Keep applying!',
        ],
        actionPath: `${dashboardFor(user.role)}/jobs`,
        actionLabel: 'Find More Jobs',
      }),
    );
  }

  @OnEvent(APP_EVENTS.JOB_STARTED, { async: true })
  async handleJobStarted(payload: JobStartedPayload): Promise<void> {
    await this.notify(
      payload.customerId,
      NotificationType.JOB_STARTED,
      APP_EVENTS.JOB_STARTED,
      (user) => ({
        heading: 'Work has started',
        paragraphs: [
          `The artisan has started work on your job "${payload.jobTitle}".`,
        ],
        ...this.jobLink(user.role, payload.jobId),
      }),
    );
  }

  @OnEvent(APP_EVENTS.JOB_COMPLETION_REQUESTED, { async: true })
  async handleJobCompletionRequested(
    payload: JobCompletionRequestedPayload,
  ): Promise<void> {
    await this.notify(
      payload.customerId,
      NotificationType.JOB_COMPLETION_REQUESTED,
      APP_EVENTS.JOB_COMPLETION_REQUESTED,
      (user) => ({
        heading: 'Is your job complete?',
        paragraphs: [
          `The artisan has marked "${payload.jobTitle}" as done.`,
          "Please check the work and confirm it is complete. Confirming releases the payment to the artisan, so if something isn't right, contact the artisan or our support team first.",
        ],
        actionPath: `${dashboardFor(user.role)}/jobs/${payload.jobId}`,
        actionLabel: 'Review and Confirm',
      }),
    );
  }

  @OnEvent(APP_EVENTS.JOB_COMPLETED, { async: true })
  async handleJobCompleted(payload: JobCompletedPayload): Promise<void> {
    await this.notify(
      payload.artisanId,
      NotificationType.JOB_COMPLETED,
      APP_EVENTS.JOB_COMPLETED,
      (user) => ({
        heading: 'Job confirmed complete',
        paragraphs: [
          `"${payload.jobTitle}" has been confirmed as complete.`,
          "Your payout is being processed. You'll be notified as soon as it's released.",
        ],
        ...this.jobLink(user.role, payload.jobId),
      }),
    );
  }

  @OnEvent(APP_EVENTS.JOB_CANCELLED, { async: true })
  async handleJobCancelled(payload: JobCancelledPayload): Promise<void> {
    await this.notify(
      payload.artisanId,
      NotificationType.JOB_CANCELLED,
      APP_EVENTS.JOB_CANCELLED,
      (user) => ({
        heading: 'Job cancelled',
        paragraphs: [
          `The customer has cancelled the job "${payload.jobTitle}".`,
          'You do not need to do anything else for this job.',
        ],
        actionPath: `${dashboardFor(user.role)}/jobs`,
        actionLabel: 'View My Jobs',
      }),
    );
  }

  @OnEvent(APP_EVENTS.JOB_EXPIRED, { async: true })
  async handleJobExpired(payload: JobExpiredPayload): Promise<void> {
    await this.notify(
      payload.customerId,
      NotificationType.JOB_EXPIRED,
      APP_EVENTS.JOB_EXPIRED,
      (user) => ({
        heading: 'Your job posting has expired',
        paragraphs: [
          `Your job posting "${payload.jobTitle}" has expired without being filled.`,
          'You can post it again whenever you are ready.',
        ],
        actionPath: `${dashboardFor(user.role)}/jobs`,
        actionLabel: 'View My Jobs',
      }),
    );
    for (const artisanId of payload.pendingArtisanIds) {
      await this.notify(
        artisanId,
        NotificationType.JOB_EXPIRED,
        APP_EVENTS.JOB_EXPIRED,
        (user) => ({
          subject: 'A Job You Applied To Has Closed',
          heading: 'A job you applied to has closed',
          paragraphs: [
            `The job "${payload.jobTitle}" has expired, so your application has been closed.`,
          ],
          actionPath: `${dashboardFor(user.role)}/jobs`,
          actionLabel: 'Find More Jobs',
        }),
      );
    }
  }

  /**
   * One email per conversation until it's read: only the first unread
   * message from the other side triggers one. Later messages still reach the
   * in-app inbox and push, but not the person's mailbox.
   */
  @OnEvent(APP_EVENTS.MESSAGE_RECEIVED, { async: true })
  async handleMessageReceived(payload: MessageReceivedPayload): Promise<void> {
    try {
      const unread = await this.messagesRepository.count({
        where: {
          conversationId: payload.conversationId,
          senderId: Not(payload.recipientId),
          isRead: false,
        },
      });
      if (unread > 1) return;
    } catch (err) {
      this.logger.error(
        `Failed to check unread messages before emailing: ${getErrorMessage(err)}`,
      );
      return;
    }
    await this.notify(
      payload.recipientId,
      NotificationType.MESSAGE_RECEIVED,
      APP_EVENTS.MESSAGE_RECEIVED,
      (user) => ({
        heading: `New message from ${payload.senderName}`,
        paragraphs: [`${payload.senderName} sent you a message:`],
        quote: payload.preview,
        actionPath: `${dashboardFor(user.role)}/messages`,
        actionLabel: 'Reply',
      }),
    );
  }

  @OnEvent(APP_EVENTS.PAYMENT_RECEIPT, { async: true })
  async handlePaymentReceipt(payload: PaymentReceiptPayload): Promise<void> {
    await this.notify(
      payload.customerId,
      NotificationType.PAYMENT_RECEIPT,
      APP_EVENTS.PAYMENT_RECEIPT,
      (user) => ({
        heading: 'Payment received',
        paragraphs: [
          `We've received your payment for "${payload.jobTitle}".`,
          'It is held securely and only released to the artisan once you confirm the work is complete.',
        ],
        details: [
          { label: 'Job', value: payload.jobTitle },
          { label: 'Amount Paid', value: formatGhs(payload.amount) },
          { label: 'Payment Reference', value: payload.reference },
        ],
        ...this.jobLink(user.role, payload.jobId),
      }),
    );
  }

  @OnEvent(APP_EVENTS.PAYMENT_SECURED, { async: true })
  async handlePaymentSecured(payload: PaymentSecuredPayload): Promise<void> {
    await this.notify(
      payload.artisanUserId,
      NotificationType.PAYMENT_SECURED,
      APP_EVENTS.PAYMENT_SECURED,
      (user) => ({
        heading: 'Payment secured',
        paragraphs: [
          `The customer has paid for "${payload.jobTitle}". You can now start work.`,
          'Your earnings are held securely and released to you once the customer confirms the work is complete.',
        ],
        details: [
          { label: 'Job', value: payload.jobTitle },
          { label: 'Your Earnings', value: formatGhs(payload.artisanAmount) },
        ],
        ...this.jobLink(user.role, payload.jobId),
      }),
    );
  }

  @OnEvent(APP_EVENTS.PAYOUT_RELEASED, { async: true })
  async handlePayoutReleased(payload: PayoutReleasedPayload): Promise<void> {
    await this.notify(
      payload.artisanUserId,
      NotificationType.PAYOUT_RELEASED,
      APP_EVENTS.PAYOUT_RELEASED,
      (user) => ({
        heading: 'Your payout is on its way',
        paragraphs: [
          `Your payout for "${payload.jobTitle}" has been sent to your payout account.`,
        ],
        details: [
          { label: 'Job', value: payload.jobTitle },
          { label: 'Amount', value: formatGhs(payload.artisanAmount) },
        ],
        actionPath: `${dashboardFor(user.role)}/earnings`,
        actionLabel: 'View Earnings',
      }),
    );
  }

  @OnEvent(APP_EVENTS.PAYMENT_REFUNDED, { async: true })
  async handlePaymentRefunded(payload: PaymentRefundedPayload): Promise<void> {
    await this.notify(
      payload.customerId,
      NotificationType.PAYMENT_REFUNDED,
      APP_EVENTS.PAYMENT_REFUNDED,
      (user) => ({
        subject: payload.fullyRefunded
          ? 'Your Refund Has Been Issued'
          : 'A Partial Refund Has Been Issued',
        heading: payload.fullyRefunded
          ? 'Your refund has been issued'
          : 'A partial refund has been issued',
        paragraphs: [
          `${formatGhs(payload.refundedAmount)} has been refunded for "${payload.jobTitle}".`,
          'It should reach your original payment method shortly. How long it takes depends on your bank or mobile money provider.',
        ],
        details: [
          { label: 'Job', value: payload.jobTitle },
          { label: 'Refunded', value: formatGhs(payload.refundedAmount) },
          {
            label: 'Refund Type',
            value: payload.fullyRefunded ? 'Full refund' : 'Partial refund',
          },
        ],
        ...this.jobLink(user.role, payload.jobId),
      }),
    );
  }

  @OnEvent(APP_EVENTS.PAYMENT_TRANSFER_FAILED, { async: true })
  async handlePaymentTransferFailed(
    payload: PaymentTransferFailedPayload,
  ): Promise<void> {
    await this.notifyAdmins(
      NotificationType.PAYMENT_TRANSFER_FAILED,
      APP_EVENTS.PAYMENT_TRANSFER_FAILED,
      {
        heading: 'A payout transfer failed',
        paragraphs: [
          `A payout to ${payload.artisanName} for "${payload.jobTitle}" failed and needs manual attention.`,
        ],
        details: [
          { label: 'Payment', value: `#${payload.paymentId}` },
          { label: 'Artisan', value: payload.artisanName },
          { label: 'Amount', value: formatGhs(payload.artisanAmount) },
          { label: 'Reason', value: payload.reason },
        ],
        actionPath: '/dashboard/admin/transactions',
        actionLabel: 'Open Transactions',
      },
    );
  }

  /** Admins get the review-queue copy; the other party is asked to respond. */
  @OnEvent(APP_EVENTS.DISPUTE_FILED, { async: true })
  async handleDisputeFiled(payload: DisputeFiledPayload): Promise<void> {
    await this.notifyAdmins(
      NotificationType.DISPUTE_FILED,
      APP_EVENTS.DISPUTE_FILED,
      {
        heading: 'A new dispute needs review',
        paragraphs: [
          `${payload.raisedByName} (${payload.raisedByRole.toLowerCase()}) opened a dispute on booking #${payload.bookingId}. It's waiting for review.`,
        ],
        actionPath: '/dashboard/admin/disputes',
        actionLabel: 'Review Dispute',
      },
    );
    if (payload.counterpartyUserId && payload.counterpartyUserId > 0) {
      await this.notify(
        payload.counterpartyUserId,
        NotificationType.DISPUTE_FILED,
        APP_EVENTS.DISPUTE_FILED,
        (user) => ({
          heading: 'A dispute was filed',
          paragraphs: [
            `${payload.raisedByName} filed a dispute about booking #${payload.bookingId}.`,
            'You can read what they reported and submit your response while our team reviews it.',
          ],
          actionPath: `${dashboardFor(user.role)}/disputes/${payload.disputeId}`,
          actionLabel: 'View and Respond',
        }),
      );
    }
  }

  @OnEvent(APP_EVENTS.DISPUTE_RESOLVED, { async: true })
  async handleDisputeResolved(payload: DisputeOutcomePayload): Promise<void> {
    await this.notifyDisputeOutcome(
      payload,
      NotificationType.DISPUTE_RESOLVED,
      APP_EVENTS.DISPUTE_RESOLVED,
      'Your dispute has been resolved',
    );
  }

  @OnEvent(APP_EVENTS.DISPUTE_CLOSED, { async: true })
  async handleDisputeClosed(payload: DisputeOutcomePayload): Promise<void> {
    await this.notifyDisputeOutcome(
      payload,
      NotificationType.DISPUTE_CLOSED,
      APP_EVENTS.DISPUTE_CLOSED,
      'Your dispute has been closed',
    );
  }

  /** Both parties, once each, in the same words as the in-app notice. */
  private async notifyDisputeOutcome(
    payload: DisputeOutcomePayload,
    type: NotificationType,
    event: string,
    heading: string,
  ): Promise<void> {
    const recipients = new Set(
      [payload.raisedByUserId, payload.counterpartyUserId].filter(
        (id): id is number => typeof id === 'number' && id > 0,
      ),
    );
    for (const userId of recipients) {
      await this.notify(userId, type, event, (user) => ({
        heading,
        paragraphs: describeDisputeOutcome(payload, userId),
        actionPath: `${dashboardFor(user.role)}/disputes/${payload.disputeId}`,
        actionLabel: 'View Dispute',
      }));
    }
  }
}
