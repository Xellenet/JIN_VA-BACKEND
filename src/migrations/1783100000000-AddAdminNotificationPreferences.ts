import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR3: the five real admin notification toggles, replacing the admin Settings
 * tab's previously-decorative rows. Each column gates an event that is
 * genuinely emitted somewhere in this codebase (see `ADMIN_PREF_KEY` in
 * `NotificationsService`):
 *
 *  - `dispute_filed`            → DISPUTE_FILED (DisputesService.raise)
 *  - `payment_transfer_failed`  → PAYMENT_TRANSFER_FAILED (PaymentsService)
 *  - `verification_submitted`   → ARTISAN_VERIFICATION_SUBMITTED (VerificationService.submit)
 *  - `review_flagged`           → REVIEW_FLAGGED (ReviewsService.flag)
 *  - `artisan_registered`       → ARTISAN_REGISTERED (AuthService signup paths)
 *
 * Defaulting to `true` matches every other opt-out-style preference column in
 * this table: an admin sees the platform queue by default and opts out, rather
 * than having to discover and opt in.
 */
export class AddAdminNotificationPreferences1783100000000
  implements MigrationInterface
{
  name = 'AddAdminNotificationPreferences1783100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_preferences"
        ADD COLUMN IF NOT EXISTS "dispute_filed"           BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "payment_transfer_failed" BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "verification_submitted"  BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "review_flagged"          BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "artisan_registered"      BOOLEAN NOT NULL DEFAULT true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_preferences"
        DROP COLUMN IF EXISTS "dispute_filed",
        DROP COLUMN IF EXISTS "payment_transfer_failed",
        DROP COLUMN IF EXISTS "verification_submitted",
        DROP COLUMN IF EXISTS "review_flagged",
        DROP COLUMN IF EXISTS "artisan_registered"
    `);
  }
}
