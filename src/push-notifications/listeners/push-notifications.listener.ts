import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PushNotificationsService } from '../push-notifications.service';
import { APP_EVENTS } from '@common/events/app.events';
import type {
  ArtisanProfileVerifiedPayload,
  ArtisanVerificationRejectedPayload,
  BookingReceivedPayload,
  BookingConfirmedPayload,
  BookingDeclinedPayload,
  BookingCancelledPayload,
  BookingCompletedPayload,
  MessageReceivedPayload,
  ReviewReceivedPayload,
} from '@common/events/app.events';

@Injectable()
export class PushNotificationsListener {
  private readonly logger = new Logger(PushNotificationsListener.name);

  constructor(private readonly pushService: PushNotificationsService) {}

  @OnEvent(APP_EVENTS.ARTISAN_PROFILE_VERIFIED, { async: true })
  async onArtisanVerified(payload: ArtisanProfileVerifiedPayload): Promise<void> {
    await this.safe(payload.artisanUserId, {
      title: 'Identity Verified',
      body: 'Your artisan profile has been verified. You now have a verified badge.',
      data: { type: APP_EVENTS.ARTISAN_PROFILE_VERIFIED },
    });
  }

  @OnEvent(APP_EVENTS.ARTISAN_VERIFICATION_REJECTED, { async: true })
  async onVerificationRejected(payload: ArtisanVerificationRejectedPayload): Promise<void> {
    await this.safe(payload.artisanUserId, {
      title: 'Verification Update',
      body: 'Your verification submission could not be approved. Tap to review the reason.',
      data: { type: APP_EVENTS.ARTISAN_VERIFICATION_REJECTED },
    });
  }

  @OnEvent(APP_EVENTS.BOOKING_RECEIVED, { async: true })
  async onBookingReceived(payload: BookingReceivedPayload): Promise<void> {
    await this.safe(payload.artisanUserId, {
      title: 'New Booking Request',
      body: `${payload.customerName} wants to book you for ${payload.scheduledDate}`,
      data: {
        type: APP_EVENTS.BOOKING_RECEIVED,
        bookingId: String(payload.bookingId),
      },
    });
  }

  @OnEvent(APP_EVENTS.BOOKING_CONFIRMED, { async: true })
  async onBookingConfirmed(payload: BookingConfirmedPayload): Promise<void> {
    await this.safe(payload.customerId, {
      title: 'Booking Confirmed',
      body: `${payload.artisanName} confirmed your booking for ${payload.scheduledDate}`,
      data: {
        type: APP_EVENTS.BOOKING_CONFIRMED,
        bookingId: String(payload.bookingId),
      },
    });
  }

  @OnEvent(APP_EVENTS.BOOKING_DECLINED, { async: true })
  async onBookingDeclined(payload: BookingDeclinedPayload): Promise<void> {
    await this.safe(payload.customerId, {
      title: 'Booking Declined',
      body: `${payload.artisanName} could not accept your booking for ${payload.scheduledDate}`,
      data: {
        type: APP_EVENTS.BOOKING_DECLINED,
        bookingId: String(payload.bookingId),
      },
    });
  }

  @OnEvent(APP_EVENTS.BOOKING_CANCELLED, { async: true })
  async onBookingCancelled(payload: BookingCancelledPayload): Promise<void> {
    await this.safe(payload.artisanUserId, {
      title: 'Booking Cancelled',
      body: `${payload.customerName} cancelled the booking scheduled for ${payload.scheduledDate}`,
      data: {
        type: APP_EVENTS.BOOKING_CANCELLED,
        bookingId: String(payload.bookingId),
      },
    });
  }

  @OnEvent(APP_EVENTS.BOOKING_COMPLETED, { async: true })
  async onBookingCompleted(payload: BookingCompletedPayload): Promise<void> {
    await this.safe(payload.artisanUserId, {
      title: 'Booking Completed',
      body: `Your booking on ${payload.scheduledDate} has been marked as completed.`,
      data: {
        type: APP_EVENTS.BOOKING_COMPLETED,
        bookingId: String(payload.bookingId),
      },
    });
  }

  @OnEvent(APP_EVENTS.MESSAGE_RECEIVED, { async: true })
  async onMessageReceived(payload: MessageReceivedPayload): Promise<void> {
    await this.safe(payload.recipientId, {
      title: `New message from ${payload.senderName}`,
      body: payload.preview,
      data: {
        type: APP_EVENTS.MESSAGE_RECEIVED,
        conversationId: String(payload.conversationId),
      },
    });
  }

  @OnEvent(APP_EVENTS.REVIEW_RECEIVED, { async: true })
  async onReviewReceived(payload: ReviewReceivedPayload): Promise<void> {
    await this.safe(payload.artisanUserId, {
      title: 'New Review',
      body: `${payload.reviewerName} left you a ${payload.rating}-star review`,
      data: {
        type: APP_EVENTS.REVIEW_RECEIVED,
        jobId: String(payload.jobId),
      },
    });
  }

  private async safe(userId: number, payload: Parameters<typeof this.pushService.sendToUser>[1]): Promise<void> {
    try {
      await this.pushService.sendToUser(userId, payload);
    } catch (err) {
      this.logger.error(`Push notification failed for user ${userId}: ${err.message}`);
    }
  }
}
