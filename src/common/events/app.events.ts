import type { Role } from '@common/types/enums';

export const APP_EVENTS = {
  JOB_APPLICATION_RECEIVED: 'job.application.received',
  JOB_APPLICATION_ACCEPTED: 'job.application.accepted',
  JOB_APPLICATION_REJECTED: 'job.application.rejected',
  JOB_STARTED: 'job.started',
  JOB_COMPLETION_REQUESTED: 'job.completion.requested',
  JOB_COMPLETED: 'job.completed',
  JOB_CANCELLED: 'job.cancelled',
  JOB_EXPIRED: 'job.expired',
  MESSAGE_RECEIVED: 'message.received',
  REVIEW_RECEIVED: 'review.received',
  ARTISAN_PROFILE_VERIFIED: 'artisan.profile.verified',
  ARTISAN_VERIFICATION_SUBMITTED: 'artisan.verification.submitted',
  ARTISAN_VERIFICATION_REJECTED: 'artisan.verification.rejected',
  BOOKING_RECEIVED: 'booking.received',
  BOOKING_CONFIRMED: 'booking.confirmed',
  BOOKING_DECLINED: 'booking.declined',
  BOOKING_CANCELLED: 'booking.cancelled',
  BOOKING_COMPLETED: 'booking.completed',
  BOOKING_EXPIRED: 'booking.expired',
  BOOKING_NO_SHOW: 'booking.no-show',
  BOOKING_REMINDER_24H: 'booking.reminder.24h',
  BOOKING_REMINDER_2H: 'booking.reminder.2h',
  PORTFOLIO_APPROVED: 'portfolio.approved',
  PORTFOLIO_REJECTED: 'portfolio.rejected',
  SECURITY_ALERT: 'security.alert',

  // ─── Payments (PD1–PD3) ─────────────────────────────────────────────────────
  /** PD1: customer's payment reached the held/secured state — "payment receipt". */
  PAYMENT_RECEIPT: 'payment.receipt',
  /**
   * PD2: the *same* held/secured transition seen from the artisan's side.
   * Deliberately a distinct event from {@link PAYMENT_RECEIPT}, not one event
   * with two recipients — the two parties get materially different messages
   * ("we received your money" vs "your money is secured for this job") and
   * are gated by different per-role preference flags.
   */
  PAYMENT_SECURED: 'payment.secured',
  /**
   * PD2: payout actually left the platform for the artisan (Paystack
   * `transfer.success`). Separate from `JOB_COMPLETED`, whose notification
   * text used to *claim* release regardless of the payment record's real
   * state.
   */
  PAYOUT_RELEASED: 'payment.payout-released',
  /** PD3: an admin refunded a payment (fully or partially). */
  PAYMENT_REFUNDED: 'payment.refunded',
  /** PR3: an artisan payout failed and needs manual admin attention. */
  PAYMENT_TRANSFER_FAILED: 'payment.transfer-failed',

  // ─── Disputes (PD4) ─────────────────────────────────────────────────────────
  /** PR3: a new dispute was opened and is waiting on admin review. */
  DISPUTE_FILED: 'dispute.filed',
  /** PD4: admin resolved a dispute — both parties are notified of the outcome. */
  DISPUTE_RESOLVED: 'dispute.resolved',
  /** PD4: admin closed a dispute — both parties are notified of the outcome. */
  DISPUTE_CLOSED: 'dispute.closed',

  // ─── Admin moderation queue (PR3) ───────────────────────────────────────────
  /** PR3: a review was flagged (FL1) and entered the moderation queue. */
  REVIEW_FLAGGED: 'review.flagged',
  /** PR3: a new artisan account was created on the platform. */
  ARTISAN_REGISTERED: 'artisan.registered',
} as const;

export type AppEventName = (typeof APP_EVENTS)[keyof typeof APP_EVENTS];

export interface JobApplicationReceivedPayload {
  customerId: number;
  artisanName: string;
  jobTitle: string;
  jobId: number;
}

export interface JobApplicationAcceptedPayload {
  artisanId: number;
  jobTitle: string;
  jobId: number;
}

export interface JobStartedPayload {
  customerId: number;
  jobTitle: string;
  jobId: number;
}

export interface JobCompletionRequestedPayload {
  customerId: number;
  jobTitle: string;
  jobId: number;
}

export interface JobCompletedPayload {
  artisanId: number;
  jobTitle: string;
  jobId: number;
}

export interface JobCancelledPayload {
  artisanId: number;
  jobTitle: string;
  jobId: number;
}

export interface MessageReceivedPayload {
  recipientId: number;
  senderName: string;
  preview: string;
  conversationId: number;
}

// ─── Payments (PD1–PD3, PR3) ──────────────────────────────────────────────────

/** PD1: customer-facing receipt for a payment that reached HELD. */
export interface PaymentReceiptPayload {
  customerId: number;
  jobId: number;
  jobTitle: string;
  /** Total the customer paid, in GHS. */
  amount: number;
  reference: string;
}

/** PD2: artisan-facing "payment secured for this job" (payment reached HELD). */
export interface PaymentSecuredPayload {
  artisanUserId: number;
  jobId: number;
  jobTitle: string;
  /** Amount earmarked for the artisan (total minus platform fee), in GHS. */
  artisanAmount: number;
}

/** PD2: artisan-facing "payout released" (payment reached RELEASED). */
export interface PayoutReleasedPayload {
  artisanUserId: number;
  jobId: number;
  jobTitle: string;
  /** Amount actually transferred to the artisan, in GHS. */
  artisanAmount: number;
}

/** PD3: customer-facing refund notification. */
export interface PaymentRefundedPayload {
  customerId: number;
  jobId: number;
  jobTitle: string;
  /** The amount refunded by *this* admin action, in GHS. */
  refundedAmount: number;
  /** True when the cumulative refunded amount now covers the full payment. */
  fullyRefunded: boolean;
}

/** PR3: admin-facing "a payout failed and needs manual attention". */
export interface PaymentTransferFailedPayload {
  paymentId: number;
  jobId: number;
  jobTitle: string;
  artisanName: string;
  /** Amount the failed transfer was for, in GHS. */
  artisanAmount: number;
  reason: string;
}

// ─── Disputes (PD4, PR3) ──────────────────────────────────────────────────────

/** PR3: admin-facing "a new dispute needs review". */
export interface DisputeFiledPayload {
  disputeId: number;
  bookingId: number;
  raisedByName: string;
  raisedByRole: Role;
}

/**
 * PD4: a dispute reached a final outcome. Carries both parties so the
 * notification listener can notify the raiser *and* the counterparty from a
 * single event, matching PRD §5.13's "both parties notified automatically".
 * Interim `UNDER_REVIEW` transitions deliberately do not emit this — only a
 * final outcome does.
 */
export interface DisputeOutcomePayload {
  disputeId: number;
  bookingId: number;
  /** The party who raised the dispute. */
  raisedByUserId: number;
  /**
   * The other party on the underlying booking. Equals `raisedByUserId` only
   * in the pathological case where booking participants can't be resolved,
   * which the emitter guards against.
   */
  counterpartyUserId: number;
  outcome: 'RESOLVED' | 'CLOSED';
  /** Admin's resolution statement. Always set for RESOLVED; absent for CLOSED. */
  resolution?: string;
}

// ─── Admin moderation queue (PR3) ─────────────────────────────────────────────

/** PR3: admin-facing "a review was flagged and is in the moderation queue". */
export interface ReviewFlaggedPayload {
  reviewId: number;
  flaggedByName: string;
  reason: string;
  artisanName: string;
}

/** PR3: admin-facing "a new artisan registered on the platform". */
export interface ArtisanRegisteredPayload {
  artisanUserId: number;
  artisanName: string;
}

export interface JobApplicationRejectedPayload {
  artisanId: number;
  jobTitle: string;
  jobId: number;
}

export interface JobExpiredPayload {
  customerId: number;
  jobTitle: string;
  jobId: number;
  pendingArtisanIds: number[];
}

export interface ArtisanProfileVerifiedPayload {
  artisanUserId: number;
}

export interface ArtisanVerificationSubmittedPayload {
  verificationId: number;
  artisanUserId: number;
  artisanName: string;
}

export interface ArtisanVerificationRejectedPayload {
  artisanUserId: number;
  reason: string;
}

export interface SecurityAlertPayload {
  userId: number;
  event: 'PASSWORD_CHANGED' | 'PASSWORD_RESET';
}

export interface BookingReceivedPayload {
  artisanUserId: number;
  customerName: string;
  scheduledDate: string;
  bookingId: number;
}

export interface BookingConfirmedPayload {
  customerId: number;
  artisanName: string;
  scheduledDate: string;
  bookingId: number;
}

export interface BookingDeclinedPayload {
  customerId: number;
  artisanName: string;
  scheduledDate: string;
  bookingId: number;
}

export interface BookingCancelledPayload {
  artisanUserId: number;
  customerName: string;
  scheduledDate: string;
  bookingId: number;
}

export interface BookingCompletedPayload {
  artisanUserId: number;
  scheduledDate: string;
  bookingId: number;
}

export interface BookingExpiredPayload {
  customerId: number;
  scheduledDate: string;
  bookingId: number;
}

export interface BookingNoShowPayload {
  /** The recipient being notified (the *other* party from the flagger). */
  recipientUserId: number;
  flaggedByName: string;
  scheduledDate: string;
  bookingId: number;
}

export interface BookingReminderPayload {
  recipientUserId: number;
  recipientRole: Role;
  scheduledDate: string;
  startTime: string;
  bookingId: number;
  milestone: '24H' | '2H';
}

export interface ReviewReceivedPayload {
  artisanUserId: number;
  jobTitle: string;
  jobId: number;
  rating: number;
  reviewerName: string;
}

export interface PortfolioApprovedPayload {
  artisanUserId: number;
  portfolioItemId: number;
}

export interface PortfolioRejectedPayload {
  artisanUserId: number;
  portfolioItemId: number;
  reason: string;
}
