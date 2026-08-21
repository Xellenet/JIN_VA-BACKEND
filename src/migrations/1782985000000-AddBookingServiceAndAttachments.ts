import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * R1/R2/J4: links a booking to the catalog service being booked (needed to
 * derive endTime via A2, and to populate the Job created on confirmation),
 * plus J4 photo attachments collected at booking-request time.
 * Nullable at the DB level for backward compatibility with any pre-existing
 * rows; `CreateBookingDto` requires `serviceId` on all new bookings.
 */
export class AddBookingServiceAndAttachments1782985000000
  implements MigrationInterface
{
  name = 'AddBookingServiceAndAttachments1782985000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "service_id" INTEGER
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD CONSTRAINT "fk_bookings_service"
        FOREIGN KEY ("service_id") REFERENCES "services" ("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings"
      ADD COLUMN IF NOT EXISTS "attachment_urls" JSONB
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "attachment_urls"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "fk_bookings_service"
    `);
    await queryRunner.query(`
      ALTER TABLE "bookings" DROP COLUMN IF EXISTS "service_id"
    `);
  }
}
