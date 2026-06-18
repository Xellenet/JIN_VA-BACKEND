export const APP_EVENTS = {
  JOB_APPLICATION_RECEIVED: 'job.application.received',
  JOB_APPLICATION_ACCEPTED: 'job.application.accepted',
  JOB_STARTED:              'job.started',
  JOB_COMPLETION_REQUESTED: 'job.completion.requested',
  JOB_COMPLETED:            'job.completed',
  JOB_CANCELLED:            'job.cancelled',
  MESSAGE_RECEIVED:         'message.received',
  REVIEW_RECEIVED:          'review.received',
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

export interface ReviewReceivedPayload {
  artisanUserId: number;
  jobTitle: string;
  jobId: number;
  rating: number;
  reviewerName: string;
}
