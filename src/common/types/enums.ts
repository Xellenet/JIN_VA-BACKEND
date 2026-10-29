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

/**
 * DR1: the three PRD §5.13 verdicts an admin must choose between when
 * resolving a dispute. Stored on the dispute distinctly from the free-text
 * `resolution` note so a ruling is queryable and auditable rather than
 * inferred from prose.
 *
 * `MUTUAL` deliberately implies **no** money action — see
 * {@link DisputeMoneyAction}.
 */
export enum DisputeOutcome {
  /** Rule for the client: refund the linked payment (full or partial). */
  REFUND_CLIENT = 'REFUND_CLIENT',
  /** Rule for the artisan: release the withheld payment to them. */
  RELEASE_ARTISAN = 'RELEASE_ARTISAN',
  /** Mutually resolved: the verdict is recorded and no money moves. */
  MUTUAL = 'MUTUAL',
}

/**
 * DR2: what actually happened to the money as part of a resolution. Recorded
 * separately from {@link DisputeOutcome} because a verdict and its money
 * action can legitimately diverge — a `REFUND_CLIENT` ruling on a dispute
 * with no linked payment (the common case today), or on a payment that was
 * already refunded, records the verdict with `NONE`. This column is what
 * makes "no money moved" an explicit, readable fact rather than an absence.
 */
export enum DisputeMoneyAction {
  /** No money moved: MUTUAL, no linked payment, or nothing left to act on. */
  NONE = 'NONE',
  /** A refund was initiated on the linked payment. */
  REFUND = 'REFUND',
  /** The withheld payment was released to the artisan. */
  RELEASE = 'RELEASE',
}

/**
 * DR5: fixed, small category list a party picks at filing time. Drives the
 * admin queue's badge slot (the free-text `reason` is prose, not a badge),
 * the server-side category filter (DQ1) and segmentation of the resolution
 * -time metric (DR6).
 */
export enum DisputeCategory {
  /** The agreed work was never finished. */
  WORK_NOT_COMPLETED = 'WORK_NOT_COMPLETED',
  /** The work was done but is below the agreed standard. */
  WORK_QUALITY = 'WORK_QUALITY',
  /** The artisan never turned up. */
  ARTISAN_NO_SHOW = 'ARTISAN_NO_SHOW',
  /** The client didn't provide access to the site/property. */
  CLIENT_NO_ACCESS = 'CLIENT_NO_ACCESS',
  /** A disagreement about how much was owed or charged. */
  PAYMENT_AMOUNT = 'PAYMENT_AMOUNT',
  /** Something was damaged during the work. */
  PROPERTY_DAMAGE = 'PROPERTY_DAMAGE',
  /** Anything the six specific categories don't cover. */
  OTHER = 'OTHER',
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

/**
 * AT5: every consequential admin action that appends a row to
 * `admin_actions`. Deliberately a *separate* vocabulary from
 * {@link ModerationAction} — `review_moderation_actions` stays exactly as the
 * reviews round built it and is neither replaced nor absorbed by this log.
 */
export enum AdminActionType {
  USER_BAN = 'USER_BAN',
  USER_UNBAN = 'USER_UNBAN',
  USER_SUSPEND = 'USER_SUSPEND',
  USER_ACTIVATE = 'USER_ACTIVATE',
  VERIFICATION_APPROVE = 'VERIFICATION_APPROVE',
  VERIFICATION_REJECT = 'VERIFICATION_REJECT',
  PORTFOLIO_APPROVE = 'PORTFOLIO_APPROVE',
  PORTFOLIO_REJECT = 'PORTFOLIO_REJECT',
  DISPUTE_RESOLVE = 'DISPUTE_RESOLVE',
  DISPUTE_CLOSE = 'DISPUTE_CLOSE',
  PAYMENT_REFUND = 'PAYMENT_REFUND',
  PAYMENT_FRAUD_FLAG = 'PAYMENT_FRAUD_FLAG',
  PAYMENT_FRAUD_FLAG_CLEARED = 'PAYMENT_FRAUD_FLAG_CLEARED',
}

/**
 * AT5: the kind of thing an {@link AdminActionType} was taken against, so the
 * log can be read (and, later, filtered) without inferring the entity type
 * from the action name.
 */
export enum AdminActionTarget {
  USER = 'USER',
  VERIFICATION = 'VERIFICATION',
  PORTFOLIO_ITEM = 'PORTFOLIO_ITEM',
  DISPUTE = 'DISPUTE',
  PAYMENT = 'PAYMENT',
}

/**
 * AT3: the three account states an admin can filter the user lists by.
 * Derived from `User.isBanned` / `User.isSuspended` rather than stored as its
 * own column — the two booleans are independent (a suspended account can
 * subsequently be banned) and `BANNED` deliberately wins when both are set.
 */
export enum AdminUserStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  BANNED = 'BANNED',
}

/**
 * AN1/AN2 (Open Question 12, resolved): the date ranges the analytics
 * endpoints accept. Admin gets `7d | 30d | 90d | 1y` per PRD §5.13; artisan
 * gets `7d | 30d | 90d | all` per PRD §5.12. Each endpoint's query DTO
 * restricts this enum to its own four values, so an admin range on the
 * artisan endpoint (or vice versa) is a 400, not a silently wrong window.
 */
export enum AnalyticsRange {
  LAST_7_DAYS = '7d',
  LAST_30_DAYS = '30d',
  LAST_90_DAYS = '90d',
  LAST_YEAR = '1y',
  ALL_TIME = 'all',
}

/** AN2: per-range bucket granularity of every analytics time series. */
export enum AnalyticsBucket {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}
