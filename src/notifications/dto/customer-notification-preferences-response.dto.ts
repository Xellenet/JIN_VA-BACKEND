import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class CustomerNotificationPreferencesResponseDto {
  @Expose() @ApiProperty() id!: number;

  // ─── Notification types ───────────────────────────────────────────────────
  @Expose() @ApiProperty({ description: 'Artisan applied to your job' })
  bookingConfirmations!: boolean;

  @Expose() @ApiProperty({ description: 'Job moved to in-progress or completion requested' })
  jobStatusUpdates!: boolean;

  @Expose() @ApiProperty({ description: 'Email receipts for completed payments' })
  paymentReceipts!: boolean;

  @Expose() @ApiProperty({ description: 'Platform discounts and special offers' })
  promotionalOffers!: boolean;

  @Expose() @ApiProperty({ description: 'Reminders for upcoming scheduled services' })
  serviceReminders!: boolean;

  @Expose() @ApiProperty({ description: 'Post-completion prompts to review an artisan' })
  reviewRequests!: boolean;

  @Expose() @ApiProperty({ description: 'Your job posting expired without being filled' })
  jobExpired!: boolean;

  @Expose() @ApiProperty({ description: 'Artisan confirmed your booking' })
  bookingConfirmed!: boolean;

  @Expose() @ApiProperty({ description: 'Artisan declined your booking request' })
  bookingDeclined!: boolean;

  @Expose() @ApiProperty({ description: 'New direct message received' })
  messageReceived!: boolean;

  // ─── Notification channels ────────────────────────────────────────────────
  @Expose() @ApiProperty({ description: 'Receive notifications via email' })
  emailEnabled!: boolean;

  @Expose() @ApiProperty({ description: 'Receive notifications via SMS' })
  smsEnabled!: boolean;

  @Expose() @ApiProperty({ description: 'Receive browser or app push notifications' })
  pushEnabled!: boolean;
}
