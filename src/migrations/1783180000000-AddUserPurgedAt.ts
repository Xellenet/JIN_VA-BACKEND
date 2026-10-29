import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C1.7/C1.8: adds the marker the scheduled account-purge job stamps once a
 * soft-deleted account's 30-day recovery window has elapsed and its personal
 * data has been irreversibly scrubbed.
 *
 * `purged_at` is deliberately a *separate* column from `deleted_at` rather
 * than a state encoded into it: the two facts are independent (`deleted_at`
 * records when the owner asked to leave, `purged_at` when the data actually
 * went), and keeping both is what lets every restore path refuse a purged row
 * by construction while the purge candidate query stays idempotent across
 * reruns.
 *
 * The `deleted_at` index backs the daily purge candidate query, which is the
 * only query in the app that scans users by deletion timestamp.
 */
export class AddUserPurgedAt1783180000000 implements MigrationInterface {
  name = 'AddUserPurgedAt1783180000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "purged_at" TIMESTAMP
    `);

    // Partial index: the purge job only ever looks at soft-deleted rows, which
    // are a tiny minority of the table.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_users_deleted_at"
        ON "users" ("deleted_at")
        WHERE "deleted_at" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_deleted_at"`);
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN IF EXISTS "purged_at"
    `);
  }
}
