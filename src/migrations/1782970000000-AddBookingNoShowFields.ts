import { MigrationInterface, QueryRunner } from 'typeorm';

/** A6: NO_SHOW status value + independent per-party no-show flag timestamps. */
export class AddBookingNoShowFields1782970000000 implements MigrationInterface {
  name = 'AddBookingNoShowFields1782970000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "chk_bookings_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD CONSTRAINT "chk_bookings_status"
        CHECK ("status" IN ('PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'DECLINED', 'EXPIRED', 'NO_SHOW'))
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "no_show_by_customer_at" TIMESTAMPTZ
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "no_show_by_artisan_at" TIMESTAMPTZ
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "no_show_by_customer_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "no_show_by_artisan_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "chk_bookings_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD CONSTRAINT "chk_bookings_status"
        CHECK ("status" IN ('PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'DECLINED', 'EXPIRED'))
    `);
  }
}
