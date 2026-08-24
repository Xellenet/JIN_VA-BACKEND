import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

/**
 * PR3: the admin-shaped notification-preferences payload. Before this, only
 * customer- and artisan-shaped DTOs existed, so `GET /notifications/preferences`
 * handed an admin a customer-shaped body full of toggles that mean nothing for
 * an admin account.
 *
 * Every toggle below gates an event that is genuinely emitted somewhere in this
 * codebase — see the `ADMIN_PREF_KEY` map in `NotificationsService` for the
 * exact event each one controls. Deliberately five rows, not eight decorative
 * ones: a toggle that can never fire is worse than no toggle.
 */
export class AdminNotificationPreferencesResponseDto {
  @Expose() @ApiProperty() id!: number;

  // ─── Notification types ───────────────────────────────────────────────────
  @Expose()
  @ApiProperty({
    description:
      'A customer or artisan opened a new dispute that needs review ' +
      '(emitted by DisputesService.raise)',
  })
  disputeFiled!: boolean;

  @Expose()
  @ApiProperty({
    description:
      'An artisan payout failed and needs manual attention ' +
      '(emitted when a Paystack transfer fails/reverses, or the transfer call itself errors)',
  })
  paymentTransferFailed!: boolean;

  @Expose()
  @ApiProperty({
    description:
      'A new artisan submitted documents for verification ' +
      '(emitted by VerificationService.submit)',
  })
  verificationSubmitted!: boolean;

  @Expose()
  @ApiProperty({
    description:
      'A review was flagged and entered the moderation queue ' +
      '(emitted by ReviewsService.flag)',
  })
  reviewFlagged!: boolean;

  @Expose()
  @ApiProperty({
    description:
      'A new artisan created an account on the platform ' +
      '(emitted on both password and social artisan signup)',
  })
  artisanRegistered!: boolean;

  // ─── Notification channels ────────────────────────────────────────────────
  @Expose()
  @ApiProperty({ description: 'Receive notifications via email' })
  emailEnabled!: boolean;

  @Expose()
  @ApiProperty({ description: 'Receive notifications via SMS' })
  smsEnabled!: boolean;

  @Expose()
  @ApiProperty({ description: 'Receive browser or app push notifications' })
  pushEnabled!: boolean;
}
