import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sign-up form v2: an optional middle name on every user. Nullable with no
 * default, so existing rows read back as "no middle name" and nothing is
 * backfilled. Additive only — every existing query and response keeps working.
 */
export class AddUserMiddlename1783340000000 implements MigrationInterface {
  name = 'AddUserMiddlename1783340000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "middlename" character varying NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "middlename"
    `);
  }
}
