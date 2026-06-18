export const APP_EVENTS = {
  JOB_APPLICATION_RECEIVED:        'job.application.received',
  JOB_APPLICATION_ACCEPTED:        'job.application.accepted',
  JOB_APPLICATION_REJECTED:        'job.application.rejected',
  JOB_STARTED:                     'job.started',
  JOB_COMPLETION_REQUESTED:        'job.completion.requested',
  JOB_COMPLETED:                   'job.completed',
  JOB_CANCELLED:                   'job.cancelled',
  JOB_EXPIRED:                     'job.expired',
  MESSAGE_RECEIVED:                'message.received',
  REVIEW_RECEIVED:                 'review.received',
  ARTISAN_PROFILE_VERIFIED:        'artisan.profile.verified',
  ARTISAN_VERIFICATION_SUBMITTED:  'artisan.verification.submitted',
  ARTISAN_VERIFICATION_REJECTED:   'artisan.verification.rejected',
  BOOKING_RECEIVED:                'booking.received',
  BOOKING_CONFIRMED:               'booking.confirmed',
  BOOKING_DECLINED:                'booking.declined',
  BOOKING_CANCELLED:               'booking.cancelled',
  BOOKING_COMPLETED:               'booking.completed',
  SECURITY_ALERT:                  'security.alert',
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

export interface ReviewReceivedPayload {
  artisanUserId: number;
  jobTitle: string;
  jobId: number;
  rating: number;
  reviewerName: string;
}
