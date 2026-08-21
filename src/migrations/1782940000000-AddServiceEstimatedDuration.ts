import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A2: per-service estimated duration, used to derive a booking's endTime.
 * Additive, backfilled default — safe on the existing `services` table.
 */
export class AddServiceEstimatedDuration1782940000000
  implements MigrationInterface
{
  name = 'AddServiceEstimatedDuration1782940000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "services"
      ADD COLUMN IF NOT EXISTS "estimated_duration_mins" INT NOT NULL DEFAULT 60
    `);
    await queryRunner.query(`
      ALTER TABLE "services"
      ADD CONSTRAINT "chk_services_estimated_duration"
        CHECK ("estimated_duration_mins" > 0 AND "estimated_duration_mins" <= 480)
        NOT VALID
    `);
    // VALIDATE separately so the constraint check itself doesn't hold a long
    // table-rewrite lock — existing rows already satisfy the default of 60.
    await queryRunner.query(`
      ALTER TABLE "services" VALIDATE CONSTRAINT "chk_services_estimated_duration"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "services" DROP CONSTRAINT IF EXISTS "chk_services_estimated_duration"
    `);
    await queryRunner.query(`
      ALTER TABLE "services" DROP COLUMN IF EXISTS "estimated_duration_mins"
    `);
  }
}
