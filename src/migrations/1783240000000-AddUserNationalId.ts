import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * QA CUS-07: customer Settings has a "National Identification" field that can
 * be set once, but there was nowhere to store it, so every save failed. Adds a
 * nullable column with a partial unique index (one account per ID). No
 * existing rows are touched.
 */
export class AddUserNationalId1783240000000 implements MigrationInterface {
  name = 'AddUserNationalId1783240000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "national_id" varchar(30)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_national_id" ON "users" ("national_id") WHERE "national_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_users_national_id"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "national_id"`,
    );
  }
}
