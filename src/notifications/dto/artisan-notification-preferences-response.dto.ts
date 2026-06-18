import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class ArtisanNotificationPreferencesResponseDto {
  @Expose() @ApiProperty() id!: number;

  // ─── Notification types ───────────────────────────────────────────────────
  @Expose() @ApiProperty({ description: 'New job postings matching your services' })
  newJobOpportunities!: boolean;

  @Expose() @ApiProperty({ description: 'Application accepted or rejected' })
  applicationUpdates!: boolean;

  @Expose() @ApiProperty({ description: 'Job cancelled or other status changes' })
  artisanJobUpdates!: boolean;

  @Expose() @ApiProperty({ description: 'Payment released after job completion' })
  paymentReleased!: boolean;

  @Expose() @ApiProperty({ description: 'New review or rating received' })
  reviewsAndRatings!: boolean;

  @Expose() @ApiProperty({ description: 'Platform promotions for artisans' })
  artisanPromotions!: boolean;

  @Expose() @ApiProperty({ description: 'Application not selected — another artisan was chosen' })
  applicationRejected!: boolean;

  @Expose() @ApiProperty({ description: 'A job you applied to expired before being filled' })
  appliedJobExpired!: boolean;

  @Expose() @ApiProperty({ description: 'Your platform profile was verified by an admin' })
  profileVerified!: boolean;

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
