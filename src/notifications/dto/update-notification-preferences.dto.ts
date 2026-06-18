import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateNotificationPreferencesDto {
  // ─── Notification channels (both roles) ──────────────────────────────────
  @ApiPropertyOptional({ description: 'Receive notifications via email' })
  @IsBoolean() @IsOptional()
  emailEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Receive notifications via SMS' })
  @IsBoolean() @IsOptional()
  smsEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Receive browser or app push notifications' })
  @IsBoolean() @IsOptional()
  pushEnabled?: boolean;

  // ─── Customer notification types ──────────────────────────────────────────
  @ApiPropertyOptional({ description: '[Customer] Artisan applied to your job' })
  @IsBoolean() @IsOptional()
  bookingConfirmations?: boolean;

  @ApiPropertyOptional({ description: '[Customer] Job status changed (started, completion requested)' })
  @IsBoolean() @IsOptional()
  jobStatusUpdates?: boolean;

  @ApiPropertyOptional({ description: '[Customer] Email receipts for completed payments' })
  @IsBoolean() @IsOptional()
  paymentReceipts?: boolean;

  @ApiPropertyOptional({ description: '[Customer] Platform discounts and special offers' })
  @IsBoolean() @IsOptional()
  promotionalOffers?: boolean;

  @ApiPropertyOptional({ description: '[Customer] Reminders for upcoming scheduled services' })
  @IsBoolean() @IsOptional()
  serviceReminders?: boolean;

  @ApiPropertyOptional({ description: '[Customer] Post-completion prompts to review an artisan' })
  @IsBoolean() @IsOptional()
  reviewRequests?: boolean;

  @ApiPropertyOptional({ description: '[Customer] Your job posting expired without being filled' })
  @IsBoolean() @IsOptional()
  jobExpired?: boolean;

  // ─── Artisan notification types ───────────────────────────────────────────
  @ApiPropertyOptional({ description: '[Artisan] New job postings matching your services' })
  @IsBoolean() @IsOptional()
  newJobOpportunities?: boolean;

  @ApiPropertyOptional({ description: '[Artisan] Application accepted or rejected' })
  @IsBoolean() @IsOptional()
  applicationUpdates?: boolean;

  @ApiPropertyOptional({ description: '[Artisan] Job cancelled or other status changes' })
  @IsBoolean() @IsOptional()
  artisanJobUpdates?: boolean;

  @ApiPropertyOptional({ description: '[Artisan] Payment released after job completion' })
  @IsBoolean() @IsOptional()
  paymentReleased?: boolean;

  @ApiPropertyOptional({ description: '[Artisan] New review or rating received' })
  @IsBoolean() @IsOptional()
  reviewsAndRatings?: boolean;

  @ApiPropertyOptional({ description: '[Artisan] Platform promotions for artisans' })
  @IsBoolean() @IsOptional()
  artisanPromotions?: boolean;

  @ApiPropertyOptional({ description: '[Artisan] Application not selected — another artisan was chosen' })
  @IsBoolean() @IsOptional()
  applicationRejected?: boolean;

  @ApiPropertyOptional({ description: '[Artisan] A job you applied to expired before being filled' })
  @IsBoolean() @IsOptional()
  appliedJobExpired?: boolean;

  @ApiPropertyOptional({ description: '[Artisan] Platform profile verified by an admin' })
  @IsBoolean() @IsOptional()
  profileVerified?: boolean;

  // ─── Shared ───────────────────────────────────────────────────────────────
  @ApiPropertyOptional({ description: 'New direct message received' })
  @IsBoolean() @IsOptional()
  messageReceived?: boolean;
}
