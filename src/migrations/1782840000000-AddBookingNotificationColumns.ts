import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBookingNotificationColumns1782840000000 implements MigrationInterface {
  name = 'AddBookingNotificationColumns1782840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const columns = [
      'booking_received',
      'booking_confirmed',
      'booking_declined',
      'booking_cancelled',
      'booking_completed_artisan',
    ];
    for (const col of columns) {
      await queryRunner.query(`
        ALTER TABLE "notification_preferences"
        ADD COLUMN IF NOT EXISTS "${col}" BOOLEAN NOT NULL DEFAULT true
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const columns = [
      'booking_received', 'booking_confirmed', 'booking_declined',
      'booking_cancelled', 'booking_completed_artisan',
    ];
    for (const col of columns) {
      await queryRunner.query(`
        ALTER TABLE "notification_preferences"
        DROP COLUMN IF EXISTS "${col}"
      `);
    }
  }
}
