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
}

/** PF1: moderation status of an artisan's portfolio (photo/video) upload. */
export enum PortfolioStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}
