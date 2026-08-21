import { MigrationInterface, QueryRunner } from 'typeorm';

/** A5: adds the EXPIRED terminal status to the bookings status check constraint. */
export class AddBookingStatusExpired1782960000000
  implements MigrationInterface
{
  name = 'AddBookingStatusExpired1782960000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "chk_bookings_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD CONSTRAINT "chk_bookings_status"
        CHECK ("status" IN ('PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'DECLINED', 'EXPIRED'))
    `);
    // A5: cron reads `WHERE status = 'PENDING' AND created_at < ...` — already
    // covered by the existing idx_bookings_status_date index (status leads it).
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "chk_bookings_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD CONSTRAINT "chk_bookings_status"
        CHECK ("status" IN ('PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'DECLINED'))
    `);
  }
}
