export enum Role{
    CUSTOMER = 'CUSTOMER',
    ADMIN = 'ADMIN',
    ARTISAN = 'ARTISAN'
}

export enum Gender{
    MALE = 'MALE',
    FEMALE = 'FEMALE',
    OTHER = 'OTHER'
}

export enum Token {
    VERIFICATION = 'VERIFICATION',
    EMAIL_VERIFICATION = 'EMAIL_VERIFICATION',
    PASSWORD_RESET = 'PASSWORD_RESET',
    REFRESH = 'REFRESH'
}

export enum Status {
    OPEN = 'OPEN',
    PENDING = 'PENDING',
    IN_PROGRESS = 'IN_PROGRESS',
    COMPLETED = 'COMPLETED',
    CANCELLED = 'CANCELLED',
    EXPIRED = 'EXPIRED'
}

export enum ApplicationStatus {
    PENDING = 'PENDING',
    ACCEPTED = 'ACCEPTED',
    REJECTED = 'REJECTED',
}

export enum BookingStatus {
  PENDING   = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  DECLINED  = 'DECLINED',
}

export enum AvailabilityStatus {
  AVAILABLE   = 'AVAILABLE',
  BUSY        = 'BUSY',
  UNAVAILABLE = 'UNAVAILABLE',
}

export enum DocumentType {
  GHANA_CARD      = 'GHANA_CARD',
  PASSPORT        = 'PASSPORT',
  VOTERS_ID       = 'VOTERS_ID',
  DRIVERS_LICENSE = 'DRIVERS_LICENSE',
  NATIONAL_ID     = 'NATIONAL_ID',
}

export enum VerificationStatus {
  PENDING      = 'PENDING',
  UNDER_REVIEW = 'UNDER_REVIEW',
  APPROVED     = 'APPROVED',
  REJECTED     = 'REJECTED',
}

export enum DevicePlatform {
  IOS     = 'ios',
  ANDROID = 'android',
  WEB     = 'web',
}

export enum NotificationType {
    JOB_APPLICATION_RECEIVED = 'JOB_APPLICATION_RECEIVED',
    JOB_APPLICATION_ACCEPTED = 'JOB_APPLICATION_ACCEPTED',
    JOB_APPLICATION_REJECTED = 'JOB_APPLICATION_REJECTED',
    JOB_STARTED              = 'JOB_STARTED',
    JOB_COMPLETION_REQUESTED = 'JOB_COMPLETION_REQUESTED',
    JOB_COMPLETED            = 'JOB_COMPLETED',
    JOB_CANCELLED            = 'JOB_CANCELLED',
    JOB_EXPIRED              = 'JOB_EXPIRED',
    MESSAGE_RECEIVED         = 'MESSAGE_RECEIVED',
    REVIEW_RECEIVED          = 'REVIEW_RECEIVED',
    ARTISAN_PROFILE_VERIFIED       = 'ARTISAN_PROFILE_VERIFIED',
    ARTISAN_VERIFICATION_REJECTED  = 'ARTISAN_VERIFICATION_REJECTED',
    BOOKING_RECEIVED               = 'BOOKING_RECEIVED',
    BOOKING_CONFIRMED              = 'BOOKING_CONFIRMED',
    BOOKING_DECLINED               = 'BOOKING_DECLINED',
    BOOKING_CANCELLED              = 'BOOKING_CANCELLED',
    BOOKING_COMPLETED              = 'BOOKING_COMPLETED',
    SECURITY_ALERT                 = 'SECURITY_ALERT',
}