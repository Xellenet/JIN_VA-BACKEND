export enum Role {
  CUSTOMER = 'CUSTOMER',
  ADMIN = 'ADMIN',
  ARTISAN = 'ARTISAN',
}

export enum Gender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER',
}

export enum Token {
  VERIFICATION = 'VERIFICATION',
  EMAIL_VERIFICATION = 'EMAIL_VERIFICATION',
  PASSWORD_RESET = 'PASSWORD_RESET',
  REFRESH = 'REFRESH',
}

export enum Status {
  OPEN = 'OPEN',
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

export enum ApplicationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
}

export enum BookingStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  DECLINED = 'DECLINED',
  /** A5: 24h passed with no artisan response. */
  EXPIRED = 'EXPIRED',
  /** A6: either party flagged the other as a no-show after the scheduled end time passed. */
  NO_SHOW = 'NO_SHOW',
}

/** A6: who is being flagged as a no-show. Both can independently apply to the same booking. */
export enum NoShowParty {
  CUSTOMER = 'CUSTOMER',
  ARTISAN = 'ARTISAN',
}

export enum AvailabilityStatus {
  AVAILABLE = 'AVAILABLE',
  BUSY = 'BUSY',
  UNAVAILABLE = 'UNAVAILABLE',
}

export enum DocumentType {
  GHANA_CARD = 'GHANA_CARD',
  PASSPORT = 'PASSPORT',
  VOTERS_ID = 'VOTERS_ID',
  DRIVERS_LICENSE = 'DRIVERS_LICENSE',
  NATIONAL_ID = 'NATIONAL_ID',
}

export enum VerificationStatus {
  PENDING = 'PENDING',
  UNDER_REVIEW = 'UNDER_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum DevicePlatform {
  IOS = 'ios',
  ANDROID = 'android',
  WEB = 'web',
}

export enum PaymentStatus {
  PENDING = 'PENDING', // payment record created, not yet paid
  HELD = 'HELD', // customer paid; funds sitting in platform account
  PENDING_TRANSFER = 'PENDING_TRANSFER', // payment held but artisan has no payout method yet
  /** Transfer to the artisan was attempted but Paystack reported transfer.failed /
   * transfer.reversed, or the transfer API call itself errored. Retryable via
   * the same retry-transfer endpoint as PENDING_TRANSFER once the underlying
   * cause (e.g. stale recipient, bank rejection) is resolved. */
  TRANSFER_FAILED = 'TRANSFER_FAILED',
  RELEASED = 'RELEASED', // transfer to artisan confirmed
  REFUNDED = 'REFUNDED', // customer refunded
  CANCELLED = 'CANCELLED', // job cancelled before payment
  FAILED = 'FAILED', // payment attempt failed
}

export enum PayoutType {
  MOBILE_MONEY = 'mobile_money',
  BANK = 'bank',
}

export enum DisputeStatus {
  OPEN = 'OPEN',
  UNDER_REVIEW = 'UNDER_REVIEW',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
}

export enum NotificationType {
  JOB_APPLICATION_RECEIVED = 'JOB_APPLICATION_RECEIVED',
  JOB_APPLICATION_ACCEPTED = 'JOB_APPLICATION_ACCEPTED',
  JOB_APPLICATION_REJECTED = 'JOB_APPLICATION_REJECTED',
  JOB_STARTED = 'JOB_STARTED',
  JOB_COMPLETION_REQUESTED = 'JOB_COMPLETION_REQUESTED',
  JOB_COMPLETED = 'JOB_COMPLETED',
  JOB_CANCELLED = 'JOB_CANCELLED',
  JOB_EXPIRED = 'JOB_EXPIRED',
  MESSAGE_RECEIVED = 'MESSAGE_RECEIVED',
  REVIEW_RECEIVED = 'REVIEW_RECEIVED',
  ARTISAN_PROFILE_VERIFIED = 'ARTISAN_PROFILE_VERIFIED',
  ARTISAN_VERIFICATION_REJECTED = 'ARTISAN_VERIFICATION_REJECTED',
  BOOKING_RECEIVED = 'BOOKING_RECEIVED',
  BOOKING_CONFIRMED = 'BOOKING_CONFIRMED',
  BOOKING_DECLINED = 'BOOKING_DECLINED',
  BOOKING_CANCELLED = 'BOOKING_CANCELLED',
  BOOKING_COMPLETED = 'BOOKING_COMPLETED',
  BOOKING_EXPIRED = 'BOOKING_EXPIRED',
  BOOKING_NO_SHOW = 'BOOKING_NO_SHOW',
  BOOKING_REMINDER = 'BOOKING_REMINDER',
  PORTFOLIO_APPROVED = 'PORTFOLIO_APPROVED',
  PORTFOLIO_REJECTED = 'PORTFOLIO_REJECTED',
  SECURITY_ALERT = 'SECURITY_ALERT',

  /** PD1: [Customer] payment reached the held/secured state. */
  PAYMENT_RECEIPT = 'PAYMENT_RECEIPT',
  /** PD2: [Artisan] payment for a job is secured on the platform. */
  PAYMENT_SECURED = 'PAYMENT_SECURED',
  /** PD2: [Artisan] payout actually released to the artisan. */
  PAYOUT_RELEASED = 'PAYOUT_RELEASED',
  /** PD3: [Customer] an admin refunded a payment. */
  PAYMENT_REFUNDED = 'PAYMENT_REFUNDED',
  /** PR3: [Admin] an artisan payout failed and needs manual attention. */
  PAYMENT_TRANSFER_FAILED = 'PAYMENT_TRANSFER_FAILED',

  /** PR3: [Admin] a new dispute was filed and awaits review. */
  DISPUTE_FILED = 'DISPUTE_FILED',
  /** PD4: [Both parties] a dispute was resolved by an admin. */
  DISPUTE_RESOLVED = 'DISPUTE_RESOLVED',
  /** PD4: [Both parties] a dispute was closed by an admin. */
  DISPUTE_CLOSED = 'DISPUTE_CLOSED',

  /** PR3: [Admin] a review was flagged and entered the moderation queue. */
  REVIEW_FLAGGED = 'REVIEW_FLAGGED',
  /** PR3: [Admin] an artisan submitted verification documents. */
  ARTISAN_VERIFICATION_SUBMITTED = 'ARTISAN_VERIFICATION_SUBMITTED',
  /** PR3: [Admin] a new artisan account was created. */
  ARTISAN_REGISTERED = 'ARTISAN_REGISTERED',
}

/** PF1: moderation status of an artisan's portfolio (photo/video) upload. */
export enum PortfolioStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/**
 * AM1: moderation status of a review.
 * `REMOVED` is intentionally never observed on a persisted row — AM3 is a
 * hard delete, so a review transitions straight from `ACTIVE`/`FLAGGED` to
 * being deleted outright (see `ReviewsService.adminRemove`). The value is
 * kept in the enum for vocabulary parity with the PRD/admin UI and so
 * `GET /admin/reviews?status=REMOVED` is a valid (always-empty) filter
 * rather than a validation error.
 */
export enum ReviewStatus {
  ACTIVE = 'ACTIVE',
  FLAGGED = 'FLAGGED',
  REMOVED = 'REMOVED',
}

/** AM5: the three actions that append a row to `review_moderation_actions`. */
export enum ModerationAction {
  FLAG = 'FLAG',
  REMOVE = 'REMOVE',
  RESTORE = 'RESTORE',
}
