import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lets an admin hide a service type instead of deleting it. A service that
 * artisans offer, or that jobs and bookings refer to, can't be deleted
 * without breaking those records, so hiding is the way to retire it: it
 * leaves the public catalogue (`GET /services`), so customers can't post new
 * jobs or bookings for it and artisans can't add it, while every existing
 * record keeps its service.
 *
 * NOT NULL DEFAULT true, so every existing row stays visible. Additive and
 * idempotent.
 */
export class AddServiceIsActive1783360000000 implements MigrationInterface {
  name = 'AddServiceIsActive1783360000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "services"
        ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "services"
        DROP COLUMN IF EXISTS "is_active"
    `);
  }
}
