import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { NotificationPreferences } from './entities/notification-preferences.entity';
import { GetNotificationsQueryDto } from './dto/get-notifications-query.dto';
import { NotificationResponseDto } from './dto/notification-response.dto';
import { CustomerNotificationPreferencesResponseDto } from './dto/customer-notification-preferences-response.dto';
import { ArtisanNotificationPreferencesResponseDto } from './dto/artisan-notification-preferences-response.dto';
import { AdminNotificationPreferencesResponseDto } from './dto/admin-notification-preferences-response.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { User } from '@users/entities/user.entity';
import {
  DisputeMoneyAction,
  DisputeOutcome,
  NotificationType,
  Role,
} from '@common/types/enums';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { APP_EVENTS } from '@common/events/app.events';
import { formatGhs } from '@common/utils/currency.util';
import type {
  JobApplicationAcceptedPayload,
  JobApplicationReceivedPayload,
  JobApplicationRejectedPayload,
  JobCancelledPayload,
  JobCompletedPayload,
  JobCompletionRequestedPayload,
  JobExpiredPayload,
  JobStartedPayload,
  MessageReceivedPayload,
  ReviewReceivedPayload,
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
  SecurityAlertPayload,
  PortfolioApprovedPayload,
  PortfolioRejectedPayload,
  PaymentReceiptPayload,
  PaymentSecuredPayload,
  PayoutReleasedPayload,
  PaymentRefundedPayload,
  PaymentTransferFailedPayload,
  DisputeFiledPayload,
  DisputeOutcomePayload,
  ReviewFlaggedPayload,
  ArtisanRegisteredPayload,
  ArtisanVerificationSubmittedPayload,
} from '@common/events/app.events';

type Pagination = {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};
type NotificationList = {
  message: string;
  data: NotificationResponseDto[];
  pagination: Pagination;
};
type PrefsData =
  | CustomerNotificationPreferencesResponseDto
  | ArtisanNotificationPreferencesResponseDto
  | AdminNotificationPreferencesResponseDto;
type PrefsResponse = { message: string; data: PrefsData };

// ─── Role-aware preference key maps ──────────────────────────────────────────
// Maps each NotificationType to the flag that gates it for that role.
// If a type has no entry for the recipient's role, it always goes through.

const CUSTOMER_PREF_KEY: Partial<
  Record<NotificationType, keyof NotificationPreferences>
> = {
  [NotificationType.JOB_APPLICATION_RECEIVED]: 'bookingConfirmations',
  [NotificationType.JOB_STARTED]: 'jobStatusUpdates',
  [NotificationType.JOB_COMPLETION_REQUESTED]: 'jobStatusUpdates',
  [NotificationType.JOB_EXPIRED]: 'jobExpired',
  [NotificationType.BOOKING_CONFIRMED]: 'bookingConfirmed',
  [NotificationType.BOOKING_DECLINED]: 'bookingDeclined',
  [NotificationType.BOOKING_EXPIRED]: 'bookingDeclined',
  [NotificationType.BOOKING_NO_SHOW]: 'bookingConfirmations',
  [NotificationType.BOOKING_REMINDER]: 'serviceReminders',
  [NotificationType.MESSAGE_RECEIVED]: 'messageReceived',
  // PD1/PD3/PD5: `paymentReceipts` was a dead toggle until now — no event
  // ever mapped to it, because the Payments module emitted nothing at all.
  [NotificationType.PAYMENT_RECEIPT]: 'paymentReceipts',
  [NotificationType.PAYMENT_REFUNDED]: 'paymentReceipts',
  // PD4/PD5: dispute outcomes deliberately have no per-type key. The gating
  // pattern this service already uses is "no entry for the recipient's role →
  // always delivered", and no customer/artisan-facing dispute toggle exists
  // (the design spec only introduces an admin-side "Dispute Filed" toggle).
  // Inventing one here would be exactly the bespoke gating logic PD5 forbids;
  // dispute outcomes still honour the global all-channels-off suppression in
  // `persist`, like every other type.
};

const ARTISAN_PREF_KEY: Partial<
  Record<NotificationType, keyof NotificationPreferences>
> = {
  [NotificationType.JOB_APPLICATION_ACCEPTED]: 'applicationUpdates',
  [NotificationType.JOB_APPLICATION_REJECTED]: 'applicationRejected',
  [NotificationType.JOB_CANCELLED]: 'artisanJobUpdates',
  /**
   * PD2: re-pointed from `paymentReleased` to `artisanJobUpdates`.
   * `JOB_COMPLETED` is a job-lifecycle notification, not a payment one — it
   * was only borrowing the payment toggle because no real payout event
   * existed. `paymentReleased` now gates the genuine `PAYOUT_RELEASED` event
   * below, so an artisan who turns off payment notifications no longer loses
   * their job-completion notification too (and vice versa).
   */
  [NotificationType.JOB_COMPLETED]: 'artisanJobUpdates',
  [NotificationType.JOB_EXPIRED]: 'appliedJobExpired',
  [NotificationType.REVIEW_RECEIVED]: 'reviewsAndRatings',
  [NotificationType.ARTISAN_PROFILE_VERIFIED]: 'profileVerified',
  [NotificationType.ARTISAN_VERIFICATION_REJECTED]: 'verificationRejected',
  [NotificationType.BOOKING_RECEIVED]: 'bookingReceived',
  [NotificationType.BOOKING_CANCELLED]: 'bookingCancelled',
  [NotificationType.BOOKING_COMPLETED]: 'bookingCompletedArtisan',
  [NotificationType.BOOKING_NO_SHOW]: 'bookingCancelled',
  [NotificationType.BOOKING_REMINDER]: 'bookingReminders',
  [NotificationType.MESSAGE_RECEIVED]: 'messageReceived',
  [NotificationType.PORTFOLIO_APPROVED]: 'portfolioApproved',
  [NotificationType.PORTFOLIO_REJECTED]: 'portfolioRejected',
  // PD2/PD5: both real payment-state notifications for the artisan now sit
  // behind the `paymentReleased` toggle that previously gated nothing real.
  [NotificationType.PAYMENT_SECURED]: 'paymentReleased',
  [NotificationType.PAYOUT_RELEASED]: 'paymentReleased',
};

/**
 * PR3: gates the five admin-facing notification types. Admin accounts
 * previously fell through to `CUSTOMER_PREF_KEY` (they aren't artisans), so
 * every admin-relevant type was ungated and every customer toggle in their
 * settings response was meaningless.
 */
const ADMIN_PREF_KEY: Partial<
  Record<NotificationType, keyof NotificationPreferences>
> = {
  [NotificationType.DISPUTE_FILED]: 'disputeFiled',
  [NotificationType.PAYMENT_TRANSFER_FAILED]: 'paymentTransferFailed',
  [NotificationType.ARTISAN_VERIFICATION_SUBMITTED]: 'verificationSubmitted',
  [NotificationType.REVIEW_FLAGGED]: 'reviewFlagged',
  [NotificationType.ARTISAN_REGISTERED]: 'artisanRegistered',
};

// Fields each role is allowed to update — prevents artisans from setting customer flags
const CUSTOMER_UPDATABLE = new Set<keyof NotificationPreferences>([
  'bookingConfirmations',
  'jobStatusUpdates',
  'paymentReceipts',
  'promotionalOffers',
  'serviceReminders',
  'reviewRequests',
  'jobExpired',
  'bookingConfirmed',
  'bookingDeclined',
  'messageReceived',
  'emailEnabled',
  'smsEnabled',
  'pushEnabled',
]);

const ARTISAN_UPDATABLE = new Set<keyof NotificationPreferences>([
  'newJobOpportunities',
  'applicationUpdates',
  'artisanJobUpdates',
  'paymentReleased',
  'reviewsAndRatings',
  'artisanPromotions',
  'applicationRejected',
  'appliedJobExpired',
  'profileVerified',
  'verificationRejected',
  'bookingReceived',
  'bookingCancelled',
  'bookingCompletedArtisan',
  'bookingReminders',
  'messageReceived',
  'portfolioApproved',
  'portfolioRejected',
  'emailEnabled',
  'smsEnabled',
  'pushEnabled',
]);

/** PR3: the five real admin toggles, plus the shared channel switches. */
const ADMIN_UPDATABLE = new Set<keyof NotificationPreferences>([
  'disputeFiled',
  'paymentTransferFailed',
  'verificationSubmitted',
  'reviewFlagged',
  'artisanRegistered',
  'emailEnabled',
  'smsEnabled',
  'pushEnabled',
]);

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationsRepository: Repository<Notification>,
    @InjectRepository(NotificationPreferences)
    private readonly prefsRepository: Repository<NotificationPreferences>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  // ─── Event listeners ────────────────────────────────────────────────────────

  @OnEvent(APP_EVENTS.JOB_APPLICATION_RECEIVED)
  async handleApplicationReceived(payload: JobApplicationReceivedPayload) {
    await this.persist(
      payload.customerId,
      NotificationType.JOB_APPLICATION_RECEIVED,
      'New Job Application',
      `${payload.artisanName} has applied to your job "${payload.jobTitle}".`,
      { jobId: payload.jobId },
    );
  }

  @OnEvent(APP_EVENTS.JOB_APPLICATION_ACCEPTED)
  async handleApplicationAccepted(payload: JobApplicationAcceptedPayload) {
    await this.persist(
      payload.artisanId,
      NotificationType.JOB_APPLICATION_ACCEPTED,
      'Application Accepted',
      `Your application for "${payload.jobTitle}" was accepted. Get ready to start work.`,
      { jobId: payload.jobId },
    );
  }

  @OnEvent(APP_EVENTS.JOB_STARTED)
  async handleJobStarted(payload: JobStartedPayload) {
    await this.persist(
      payload.customerId,
      NotificationType.JOB_STARTED,
      'Work Has Begun',
      `The artisan has started work on your job "${payload.jobTitle}".`,
      { jobId: payload.jobId },
    );
  }

  @OnEvent(APP_EVENTS.JOB_COMPLETION_REQUESTED)
  async handleCompletionRequested(payload: JobCompletionRequestedPayload) {
    await this.persist(
      payload.customerId,
      NotificationType.JOB_COMPLETION_REQUESTED,
      'Confirm Completion',
      `The artisan has marked "${payload.jobTitle}" as done. Confirm to release payment.`,
      { jobId: payload.jobId },
    );
  }

  /**
   * PD2: the body no longer claims "your payment has been released". Job
   * completion only *triggers* a payout attempt — the transfer can land in
   * PENDING_TRANSFER (no payout method on file) or TRANSFER_FAILED, in which
   * case the old wording was simply false. The real release is announced by
   * {@link handlePayoutReleased}, driven by the payment record's actual state.
   */
  @OnEvent(APP_EVENTS.JOB_COMPLETED)
  async handleJobCompleted(payload: JobCompletedPayload) {
    await this.persist(
      payload.artisanId,
      NotificationType.JOB_COMPLETED,
      'Job Confirmed Complete',
      `"${payload.jobTitle}" has been confirmed as complete. Your payout is being processed — you'll be notified as soon as it's released.`,
      { jobId: payload.jobId },
    );
  }

  @OnEvent(APP_EVENTS.JOB_CANCELLED)
  async handleJobCancelled(payload: JobCancelledPayload) {
    await this.persist(
      payload.artisanId,
      NotificationType.JOB_CANCELLED,
      'Job Cancelled',
      `The job "${payload.jobTitle}" has been cancelled by the customer.`,
      { jobId: payload.jobId },
    );
  }

  @OnEvent(APP_EVENTS.MESSAGE_RECEIVED)
  async handleMessageReceived(payload: MessageReceivedPayload) {
    await this.persist(
      payload.recipientId,
      NotificationType.MESSAGE_RECEIVED,
      `New message from ${payload.senderName}`,
      `"${payload.preview}"`,
      { conversationId: payload.conversationId },
    );
  }

  @OnEvent(APP_EVENTS.REVIEW_RECEIVED)
  async handleReviewReceived(payload: ReviewReceivedPayload) {
    await this.persist(
      payload.artisanUserId,
      NotificationType.REVIEW_RECEIVED,
      'New Review Received',
      `${payload.reviewerName} gave you ${payload.rating}★ for "${payload.jobTitle}".`,
      { jobId: payload.jobId, rating: payload.rating },
    );
  }

  @OnEvent(APP_EVENTS.JOB_APPLICATION_REJECTED)
  async handleApplicationRejected(payload: JobApplicationRejectedPayload) {
    await this.persist(
      payload.artisanId,
      NotificationType.JOB_APPLICATION_REJECTED,
      'Application Not Selected',
      `Your application for "${payload.jobTitle}" was not selected. Keep applying!`,
      { jobId: payload.jobId },
    );
  }

  @OnEvent(APP_EVENTS.JOB_EXPIRED)
  async handleJobExpired(payload: JobExpiredPayload) {
    // Notify the customer whose posting expired
    await this.persist(
      payload.customerId,
      NotificationType.JOB_EXPIRED,
      'Job Posting Expired',
      `Your job posting "${payload.jobTitle}" has expired without being filled.`,
      { jobId: payload.jobId },
    );
    // Notify each artisan who had a pending application on this job
    for (const artisanId of payload.pendingArtisanIds) {
      await this.persist(
        artisanId,
        NotificationType.JOB_EXPIRED,
        'Job No Longer Available',
        `The job "${payload.jobTitle}" has expired. Your application has been closed.`,
        { jobId: payload.jobId },
      );
    }
  }

  @OnEvent(APP_EVENTS.ARTISAN_PROFILE_VERIFIED)
  async handleProfileVerified(payload: ArtisanProfileVerifiedPayload) {
    await this.persist(
      payload.artisanUserId,
      NotificationType.ARTISAN_PROFILE_VERIFIED,
      'Profile Verified',
      'Your artisan profile has been verified. You now have full access to the platform.',
    );
  }

  @OnEvent(APP_EVENTS.BOOKING_RECEIVED)
  async handleBookingReceived(payload: BookingReceivedPayload) {
    await this.persist(
      payload.artisanUserId,
      NotificationType.BOOKING_RECEIVED,
      'New Booking Request',
      `${payload.customerName} has requested a booking on ${payload.scheduledDate}.`,
      { bookingId: payload.bookingId },
    );
  }

  @OnEvent(APP_EVENTS.BOOKING_CONFIRMED)
  async handleBookingConfirmed(payload: BookingConfirmedPayload) {
    await this.persist(
      payload.customerId,
      NotificationType.BOOKING_CONFIRMED,
      'Booking Confirmed',
      `Your booking on ${payload.scheduledDate} has been confirmed by ${payload.artisanName}.`,
      { bookingId: payload.bookingId },
    );
  }

  @OnEvent(APP_EVENTS.BOOKING_DECLINED)
  async handleBookingDeclined(payload: BookingDeclinedPayload) {
    await this.persist(
      payload.customerId,
      NotificationType.BOOKING_DECLINED,
      'Booking Declined',
      `Your booking request on ${payload.scheduledDate} was declined by ${payload.artisanName}.`,
      { bookingId: payload.bookingId },
    );
  }

  @OnEvent(APP_EVENTS.BOOKING_CANCELLED)
  async handleBookingCancelled(payload: BookingCancelledPayload) {
    await this.persist(
      payload.artisanUserId,
      NotificationType.BOOKING_CANCELLED,
      'Booking Cancelled',
      `${payload.customerName} cancelled the booking on ${payload.scheduledDate}.`,
      { bookingId: payload.bookingId },
    );
  }

  @OnEvent(APP_EVENTS.BOOKING_COMPLETED)
  async handleBookingCompleted(payload: BookingCompletedPayload) {
    await this.persist(
      payload.artisanUserId,
      NotificationType.BOOKING_COMPLETED,
      'Booking Marked Complete',
      `The booking on ${payload.scheduledDate} was marked as completed by the customer.`,
      { bookingId: payload.bookingId },
    );
  }

  @OnEvent(APP_EVENTS.BOOKING_EXPIRED)
  async handleBookingExpired(payload: BookingExpiredPayload) {
    await this.persist(
      payload.customerId,
      NotificationType.BOOKING_EXPIRED,
      'Booking Request Expired',
      `Your booking request for ${payload.scheduledDate} expired without a response from the artisan.`,
      { bookingId: payload.bookingId },
    );
  }

  @OnEvent(APP_EVENTS.BOOKING_NO_SHOW)
  async handleBookingNoShow(payload: BookingNoShowPayload) {
    await this.persist(
      payload.recipientUserId,
      NotificationType.BOOKING_NO_SHOW,
      'No-Show Reported',
      `${payload.flaggedByName} reported you as a no-show for the ${payload.scheduledDate} appointment.`,
      { bookingId: payload.bookingId },
    );
  }

  @OnEvent(APP_EVENTS.BOOKING_REMINDER_24H)
  async handleBookingReminder24h(payload: BookingReminderPayload) {
    await this.persistReminder(payload);
  }

  @OnEvent(APP_EVENTS.BOOKING_REMINDER_2H)
  async handleBookingReminder2h(payload: BookingReminderPayload) {
    await this.persistReminder(payload);
  }

  private async persistReminder(payload: BookingReminderPayload) {
    const hours = payload.milestone === '24H' ? '24 hours' : '2 hours';
    await this.persist(
      payload.recipientUserId,
      NotificationType.BOOKING_REMINDER,
      'Upcoming Appointment Reminder',
      `Reminder: you have an appointment on ${payload.scheduledDate} at ${payload.startTime}, in about ${hours}.`,
      { bookingId: payload.bookingId, milestone: payload.milestone },
    );
  }

  @OnEvent(APP_EVENTS.ARTISAN_VERIFICATION_REJECTED)
  async handleVerificationRejected(
    payload: ArtisanVerificationRejectedPayload,
  ) {
    await this.persist(
      payload.artisanUserId,
      NotificationType.ARTISAN_VERIFICATION_REJECTED,
      'Verification Submission Rejected',
      `Your identity verification was not approved. Reason: ${payload.reason}. Please resubmit with correct documents.`,
    );
  }

  @OnEvent(APP_EVENTS.PORTFOLIO_APPROVED)
  async handlePortfolioApproved(payload: PortfolioApprovedPayload) {
    await this.persist(
      payload.artisanUserId,
      NotificationType.PORTFOLIO_APPROVED,
      'Portfolio Item Approved',
      'Your portfolio item has been approved and is now visible on your public profile.',
      { portfolioItemId: payload.portfolioItemId },
    );
  }

  @OnEvent(APP_EVENTS.PORTFOLIO_REJECTED)
  async handlePortfolioRejected(payload: PortfolioRejectedPayload) {
    await this.persist(
      payload.artisanUserId,
      NotificationType.PORTFOLIO_REJECTED,
      'Portfolio Item Rejected',
      `Your portfolio item was not approved. Reason: ${payload.reason}. You can resubmit it from your portfolio management view.`,
      { portfolioItemId: payload.portfolioItemId },
    );
  }

  // ─── Payments (PD1–PD3) ─────────────────────────────────────────────────────

  /** PD1: the customer's receipt, fired when their payment reaches HELD. */
  @OnEvent(APP_EVENTS.PAYMENT_RECEIPT)
  async handlePaymentReceipt(payload: PaymentReceiptPayload) {
    await this.persist(
      payload.customerId,
      NotificationType.PAYMENT_RECEIPT,
      'Payment Received',
      `We've received your payment of ${formatGhs(payload.amount)} for "${payload.jobTitle}". It's held securely until you confirm the work is complete.`,
      { jobId: payload.jobId, reference: payload.reference },
    );
  }

  /**
   * PD2: the artisan's side of the same HELD transition — a distinct message
   * from the customer's receipt, and gated by a different toggle.
   */
  @OnEvent(APP_EVENTS.PAYMENT_SECURED)
  async handlePaymentSecured(payload: PaymentSecuredPayload) {
    await this.persist(
      payload.artisanUserId,
      NotificationType.PAYMENT_SECURED,
      'Payment Secured',
      `${formatGhs(payload.artisanAmount)} is secured for "${payload.jobTitle}". It's released to you once the customer confirms the work is complete.`,
      { jobId: payload.jobId },
    );
  }

  /** PD2: the real payout-released notification, driven by transfer.success. */
  @OnEvent(APP_EVENTS.PAYOUT_RELEASED)
  async handlePayoutReleased(payload: PayoutReleasedPayload) {
    await this.persist(
      payload.artisanUserId,
      NotificationType.PAYOUT_RELEASED,
      'Payout Released',
      `${formatGhs(payload.artisanAmount)} has been released to your payout account for "${payload.jobTitle}".`,
      { jobId: payload.jobId },
    );
  }

  /** PD3: the customer gets a real signal when their money comes back. */
  @OnEvent(APP_EVENTS.PAYMENT_REFUNDED)
  async handlePaymentRefunded(payload: PaymentRefundedPayload) {
    const scope = payload.fullyRefunded ? 'Refund Issued' : 'Partial Refund';
    await this.persist(
      payload.customerId,
      NotificationType.PAYMENT_REFUNDED,
      scope,
      `${formatGhs(payload.refundedAmount)} has been refunded for "${payload.jobTitle}". It should reach your original payment method shortly.`,
      { jobId: payload.jobId, fullyRefunded: payload.fullyRefunded },
    );
  }

  /** PR3: routed to every admin, not to either party of the payment. */
  @OnEvent(APP_EVENTS.PAYMENT_TRANSFER_FAILED)
  async handlePaymentTransferFailed(payload: PaymentTransferFailedPayload) {
    await this.persistForAdmins(
      NotificationType.PAYMENT_TRANSFER_FAILED,
      'Payout Transfer Failed',
      `A payout of ${formatGhs(payload.artisanAmount)} to ${payload.artisanName} for "${payload.jobTitle}" failed and needs manual attention. Reason: ${payload.reason}`,
      { paymentId: payload.paymentId, jobId: payload.jobId },
    );
  }

  // ─── Disputes (PD4) ─────────────────────────────────────────────────────────

  /**
   * PR3: admin-queue notification when a dispute is opened.
   *
   * DR4: the **counterparty** is now notified too. Before this round the
   * filing notification went to admins only, so the party a dispute was filed
   * against was never told it existed — the first they heard of anything was
   * the resolution notice, by which point they had no way to put their side.
   * Their copy is deliberately not the admin's queue copy: it tells them a
   * response is wanted, not that a queue item is waiting.
   */
  @OnEvent(APP_EVENTS.DISPUTE_FILED)
  async handleDisputeFiled(payload: DisputeFiledPayload) {
    const meta = {
      disputeId: payload.disputeId,
      bookingId: payload.bookingId,
      ...(payload.category ? { category: payload.category } : {}),
    };

    await this.persistForAdmins(
      NotificationType.DISPUTE_FILED,
      'New Dispute Filed',
      `${payload.raisedByName} (${payload.raisedByRole.toLowerCase()}) opened a dispute on booking #${payload.bookingId}. It's waiting for review.`,
      meta,
    );

    if (payload.counterpartyUserId && payload.counterpartyUserId > 0) {
      await this.persist(
        payload.counterpartyUserId,
        NotificationType.DISPUTE_FILED,
        'A Dispute Was Filed',
        `${payload.raisedByName} filed a dispute about booking #${payload.bookingId}. ` +
          'You can read what they reported and submit your response while our team reviews it.',
        meta,
      );
    }
  }

  /** PD4: PRD §5.13 — "both parties notified automatically" on the outcome. */
  @OnEvent(APP_EVENTS.DISPUTE_RESOLVED)
  async handleDisputeResolved(payload: DisputeOutcomePayload) {
    await this.notifyDisputeOutcome(
      payload,
      NotificationType.DISPUTE_RESOLVED,
      'Dispute Resolved',
    );
  }

  /** PD4: same treatment for the "closed" outcome. */
  @OnEvent(APP_EVENTS.DISPUTE_CLOSED)
  async handleDisputeClosed(payload: DisputeOutcomePayload) {
    await this.notifyDisputeOutcome(
      payload,
      NotificationType.DISPUTE_CLOSED,
      'Dispute Closed',
    );
  }

  /**
   * Notifies both sides of a dispute outcome. De-duplicates on user id so a
   * malformed payload where both ids resolve to the same person can't produce
   * two identical rows.
   *
   * DR2/DR4: the body now states the **verdict** and, where money moved, the
   * **amount** — and states it from each recipient's own side, so the client
   * reads "Refunded to you: GH₵ 1,850.00" and the artisan reads that the same
   * amount was refunded to the client, rather than both being handed the raw
   * enum name. Amounts route through the shared `formatGhs` helper so they
   * read identically to the same amount in the UI.
   */
  private async notifyDisputeOutcome(
    payload: DisputeOutcomePayload,
    type: NotificationType,
    title: string,
  ): Promise<void> {
    const recipients = new Set(
      [payload.raisedByUserId, payload.counterpartyUserId].filter(
        (id): id is number => typeof id === 'number' && id > 0,
      ),
    );
    for (const userId of recipients) {
      await this.persist(
        userId,
        type,
        title,
        this.buildDisputeOutcomeBody(payload, userId),
        {
          disputeId: payload.disputeId,
          bookingId: payload.bookingId,
          outcome: payload.outcome,
          ...(payload.verdict ? { verdict: payload.verdict } : {}),
          ...(payload.moneyAction ? { moneyAction: payload.moneyAction } : {}),
          ...(payload.moneyAmount != null
            ? { moneyAmount: payload.moneyAmount }
            : {}),
        },
      );
    }
  }

  /** DR2/DR4: verdict + money movement, written from `recipientId`'s side. */
  private buildDisputeOutcomeBody(
    payload: DisputeOutcomePayload,
    recipientId: number,
  ): string {
    if (payload.outcome === 'CLOSED') {
      return (
        `The dispute on booking #${payload.bookingId} has been closed. ` +
        'If you still need help, contact support.'
      );
    }

    const parts = [
      `The dispute on booking #${payload.bookingId} has been resolved.`,
    ];

    switch (payload.verdict) {
      case DisputeOutcome.REFUND_CLIENT:
        parts.push('Outcome: ruled for the client.');
        break;
      case DisputeOutcome.RELEASE_ARTISAN:
        parts.push('Outcome: ruled for the artisan.');
        break;
      case DisputeOutcome.MUTUAL:
        parts.push('Outcome: mutually resolved.');
        break;
      default:
        break;
    }

    const amount = payload.moneyAmount;
    if (
      payload.moneyAction === DisputeMoneyAction.REFUND &&
      amount != null &&
      amount > 0
    ) {
      parts.push(
        recipientId === payload.customerUserId
          ? `Refunded to you: ${formatGhs(amount)}. It should reach your original payment method shortly.`
          : `${formatGhs(amount)} was refunded to the client.`,
      );
    } else if (
      payload.moneyAction === DisputeMoneyAction.RELEASE &&
      amount != null &&
      amount > 0
    ) {
      parts.push(
        recipientId === payload.artisanUserId
          ? `Released to you: ${formatGhs(amount)}.`
          : `${formatGhs(amount)} was released to the artisan.`,
      );
    } else if (payload.moneyAction === DisputeMoneyAction.NONE) {
      parts.push('No change was made to the payment.');
    }

    if (payload.resolution)
      parts.push(`Note from our team: ${payload.resolution}`);

    return parts.join(' ');
  }

  // ─── Admin moderation queue (PR3) ───────────────────────────────────────────

  @OnEvent(APP_EVENTS.REVIEW_FLAGGED)
  async handleReviewFlagged(payload: ReviewFlaggedPayload) {
    await this.persistForAdmins(
      NotificationType.REVIEW_FLAGGED,
      'Review Flagged for Moderation',
      `${payload.flaggedByName} flagged a review of ${payload.artisanName}. Reason: ${payload.reason}`,
      { reviewId: payload.reviewId },
    );
  }

  @OnEvent(APP_EVENTS.ARTISAN_VERIFICATION_SUBMITTED)
  async handleVerificationSubmitted(
    payload: ArtisanVerificationSubmittedPayload,
  ) {
    await this.persistForAdmins(
      NotificationType.ARTISAN_VERIFICATION_SUBMITTED,
      'Verification Submitted',
      `${payload.artisanName} submitted identity documents for verification. The submission is waiting for review.`,
      {
        verificationId: payload.verificationId,
        artisanUserId: payload.artisanUserId,
      },
    );
  }

  @OnEvent(APP_EVENTS.ARTISAN_REGISTERED)
  async handleArtisanRegistered(payload: ArtisanRegisteredPayload) {
    await this.persistForAdmins(
      NotificationType.ARTISAN_REGISTERED,
      'New Artisan Registered',
      `${payload.artisanName} created an artisan account on the platform.`,
      { artisanUserId: payload.artisanUserId },
    );
  }

  @OnEvent(APP_EVENTS.SECURITY_ALERT)
  async handleSecurityAlert(payload: SecurityAlertPayload) {
    // Security alerts bypass preferences — always persisted regardless of user settings
    try {
      const titles: Record<SecurityAlertPayload['event'], string> = {
        PASSWORD_CHANGED: 'Password Changed',
        PASSWORD_RESET: 'Password Reset',
      };
      const bodies: Record<SecurityAlertPayload['event'], string> = {
        PASSWORD_CHANGED:
          "Your account password was changed. If this wasn't you, contact support immediately.",
        PASSWORD_RESET:
          "Your account password was reset. If this wasn't you, contact support immediately.",
      };
      await this.notificationsRepository.save(
        this.notificationsRepository.create({
          user: { id: payload.userId },
          type: NotificationType.SECURITY_ALERT,
          title: titles[payload.event],
          body: bodies[payload.event],
          payload: { event: payload.event },
        }),
      );
    } catch (err) {
      this.logger.error(
        `Failed to persist SECURITY_ALERT for user ${payload.userId}: ${(err as Error).message}`,
      );
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async findAll(
    userId: number,
    query: GetNotificationsQueryDto,
  ): Promise<NotificationList> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.notificationsRepository
      .createQueryBuilder('notif')
      .where('notif.user = :userId', { userId })
      .orderBy('notif.createdAt', 'DESC');

    if (query.isRead !== undefined) {
      qb.andWhere('notif.isRead = :isRead', { isRead: query.isRead });
    }

    const [notifications, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      message: SUCCESS_MESSAGES.NOTIFICATION.ALL_RETRIEVED,
      data: plainToInstance(NotificationResponseDto, notifications, {
        excludeExtraneousValues: true,
      }),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getUnreadCount(userId: number): Promise<{ count: number }> {
    const count = await this.notificationsRepository.count({
      where: { user: { id: userId }, isRead: false },
    });
    return { count };
  }

  async markRead(
    userId: number,
    notificationId: number,
  ): Promise<{ message: string }> {
    const notification = await this.notificationsRepository.findOne({
      where: { id: notificationId, user: { id: userId } },
    });
    if (!notification) throw new NotFoundException('Notification not found.');
    notification.isRead = true;
    await this.notificationsRepository.save(notification);
    return { message: SUCCESS_MESSAGES.NOTIFICATION.MARKED_READ };
  }

  async markAllRead(userId: number): Promise<{ message: string }> {
    await this.notificationsRepository
      .createQueryBuilder()
      .update(Notification)
      .set({ isRead: true })
      .where('user_id = :userId AND is_read = false', { userId })
      .execute();
    return { message: SUCCESS_MESSAGES.NOTIFICATION.ALL_MARKED_READ };
  }

  // ─── Notification preferences ────────────────────────────────────────────────

  /**
   * Returns the authenticated user's notification preferences.
   * Creates a default record on first access. The shape differs by role —
   * artisans see artisan-specific toggles; customers see customer-specific ones.
   * Both roles see the notification channel toggles (email, SMS, push).
   */
  async getPreferences(userId: number): Promise<PrefsResponse> {
    const prefs = await this.findOrCreatePrefs(userId);
    return {
      message: SUCCESS_MESSAGES.NOTIFICATION_PREFERENCES.RETRIEVED,
      data: this.toPrefsDto(prefs),
    };
  }

  /**
   * Partially updates the authenticated user's notification preferences.
   * Only role-relevant fields are applied — a customer cannot accidentally
   * set artisan-only flags and vice versa.
   */
  async updatePreferences(
    userId: number,
    dto: UpdateNotificationPreferencesDto,
  ): Promise<PrefsResponse> {
    const prefs = await this.findOrCreatePrefs(userId);
    const allowedKeys = this.updatableKeysFor(prefs.user.role);

    for (const [key, value] of Object.entries(dto) as [
      string,
      boolean | undefined,
    ][]) {
      if (
        allowedKeys.has(key as keyof NotificationPreferences) &&
        value !== undefined
      ) {
        (prefs as unknown as Record<string, boolean>)[key] = value;
      }
    }

    await this.prefsRepository.save(prefs);
    return {
      message: SUCCESS_MESSAGES.NOTIFICATION_PREFERENCES.UPDATED,
      data: this.toPrefsDto(prefs),
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /** PR3: admins get their own shape rather than falling through to customer. */
  private toPrefsDto(prefs: NotificationPreferences): PrefsData {
    if (prefs.user.role === Role.ARTISAN) {
      return plainToInstance(ArtisanNotificationPreferencesResponseDto, prefs, {
        excludeExtraneousValues: true,
      });
    }
    if (prefs.user.role === Role.ADMIN) {
      return plainToInstance(AdminNotificationPreferencesResponseDto, prefs, {
        excludeExtraneousValues: true,
      });
    }
    return plainToInstance(CustomerNotificationPreferencesResponseDto, prefs, {
      excludeExtraneousValues: true,
    });
  }

  /**
   * The write-side counterpart of {@link toPrefsDto} — an admin can only set
   * admin toggles, so a stray customer/artisan flag in the request body is
   * ignored rather than silently persisted onto an admin's row.
   */
  private updatableKeysFor(role: Role): Set<keyof NotificationPreferences> {
    if (role === Role.ARTISAN) return ARTISAN_UPDATABLE;
    if (role === Role.ADMIN) return ADMIN_UPDATABLE;
    return CUSTOMER_UPDATABLE;
  }

  /** Picks the per-type gating map that applies to a recipient's role. */
  private prefKeyMapFor(
    role: Role,
  ): Partial<Record<NotificationType, keyof NotificationPreferences>> {
    if (role === Role.ARTISAN) return ARTISAN_PREF_KEY;
    if (role === Role.ADMIN) return ADMIN_PREF_KEY;
    return CUSTOMER_PREF_KEY;
  }

  private async findOrCreatePrefs(
    userId: number,
  ): Promise<NotificationPreferences> {
    let prefs = await this.prefsRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user'],
    });
    if (!prefs) {
      await this.prefsRepository.save(
        this.prefsRepository.create({ user: { id: userId } }),
      );
      prefs = await this.prefsRepository.findOne({
        where: { user: { id: userId } },
        relations: ['user'],
      });
    }
    return prefs!;
  }

  /**
   * PR3: fans an admin-queue notification out to every admin account, each one
   * still individually preference-gated by the normal {@link persist} path —
   * one admin muting "Dispute Filed" does not mute it for the others.
   *
   * Failures are logged, never thrown: these are triggered from inside domain
   * flows (a dispute being filed, a payout failing) and must never fail the
   * originating request.
   */
  private async persistForAdmins(
    type: NotificationType,
    title: string,
    body: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const admins = await this.usersRepository.find({
        where: { role: Role.ADMIN },
        select: ['id'],
      });
      if (admins.length === 0) {
        this.logger.warn(
          `No admin accounts found — ${type} notification not delivered to anyone.`,
        );
        return;
      }
      for (const admin of admins) {
        await this.persist(admin.id, type, title, body, payload);
      }
    } catch (err) {
      this.logger.error(
        `Failed to fan out ${type} notification to admins: ${(err as Error).message}`,
      );
    }
  }

  private async persist(
    userId: number,
    type: NotificationType,
    title: string,
    body: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const prefs = await this.prefsRepository.findOne({
        where: { user: { id: userId } },
        relations: ['user'],
      });

      if (prefs) {
        const prefMap = this.prefKeyMapFor(prefs.user.role);
        const prefKey = prefMap[type];
        // Skip if the user has explicitly disabled this notification type
        if (prefKey && prefs[prefKey] === false) return;
        // Skip in-app delivery if the user has disabled all channels
        // (email/SMS/push channel checks happen in their respective send services)
        if (!prefs.pushEnabled && !prefs.emailEnabled && !prefs.smsEnabled)
          return;
      }

      await this.notificationsRepository.save(
        this.notificationsRepository.create({
          user: { id: userId },
          type,
          title,
          body,
          payload,
        }),
      );
    } catch (err) {
      this.logger.error(
        `Failed to persist ${type} notification for user ${userId}: ${(err as Error).message}`,
      );
    }
  }
}
