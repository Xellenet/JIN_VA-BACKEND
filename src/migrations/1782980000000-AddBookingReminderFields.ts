import { MigrationInterface, QueryRunner } from 'typeorm';

/** A7: idempotency flags for the 24h/2h pre-appointment reminder cron. */
export class AddBookingReminderFields1782980000000
  implements MigrationInterface
{
  name = 'AddBookingReminderFields1782980000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "reminder_24h_sent_at" TIMESTAMPTZ
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "reminder_2h_sent_at" TIMESTAMPTZ
    `);
    // Speeds up the every-30-min reminder cron's candidate scan.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_bookings_reminder_candidates"
        ON "bookings" ("status", "scheduled_date", "start_time")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_bookings_reminder_candidates"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "reminder_24h_sent_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "reminder_2h_sent_at"
    `);
  }
}
