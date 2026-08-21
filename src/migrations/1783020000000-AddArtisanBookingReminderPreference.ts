import { MigrationInterface, QueryRunner } from 'typeorm';

/** A7: per-event notification preference gating the artisan-side reminder send. */
export class AddArtisanBookingReminderPreference1783020000000
  implements MigrationInterface
{
  name = 'AddArtisanBookingReminderPreference1783020000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_preferences"
      ADD COLUMN IF NOT EXISTS "booking_reminders" BOOLEAN NOT NULL DEFAULT true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "booking_reminders"
    `);
  }
}
