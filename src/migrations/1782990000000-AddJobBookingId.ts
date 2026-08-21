import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * R2: links a Job to the Booking it was created/confirmed from. A unique
 * constraint on booking_id guarantees at most one Job per Booking, which is
 * the guard against a duplicate-confirmation race creating two jobs.
 */
export class AddJobBookingId1782990000000 implements MigrationInterface {
  name = 'AddJobBookingId1782990000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "jobs"
      ADD COLUMN IF NOT EXISTS "booking_id" INTEGER
    `);
    await queryRunner.query(`
      ALTER TABLE "jobs"
      ADD CONSTRAINT "uq_jobs_booking_id" UNIQUE ("booking_id")
    `);
    await queryRunner.query(`
      ALTER TABLE "jobs"
      ADD CONSTRAINT "fk_jobs_booking"
        FOREIGN KEY ("booking_id") REFERENCES "bookings" ("id") ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "fk_jobs_booking"
    `);
    await queryRunner.query(`
      ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "uq_jobs_booking_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "jobs" DROP COLUMN IF EXISTS "booking_id"
    `);
  }
}
