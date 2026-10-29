import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AM1: adds moderation-related columns to `reviews`.
 *
 * Note on the "missing unique constraint on (job_id)" audit finding: it is
 * NOT missing — `AddReviewJobEnforcement1781800000000` already added a
 * partial unique index (`UQ_reviews_job_id`) on `reviews.job_id`. Verified
 * present before writing this migration; no duplicate constraint is added
 * here.
 */
export class AddReviewStatusAndModerationFields1783050000000
  implements MigrationInterface
{
  name = 'AddReviewStatusAndModerationFields1783050000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "reviews" ADD COLUMN "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    `);
    await queryRunner.query(`
      ALTER TABLE "reviews" ADD CONSTRAINT "chk_reviews_status"
        CHECK ("status" IN ('ACTIVE', 'FLAGGED', 'REMOVED'))
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_reviews_status" ON "reviews" ("status")
    `);

    await queryRunner.query(`
      ALTER TABLE "reviews" ADD COLUMN "edited_at" TIMESTAMP NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "reviews" ADD COLUMN "artisan_reply" TEXT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "reviews" ADD COLUMN "artisan_replied_at" TIMESTAMP NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reviews" DROP COLUMN "artisan_replied_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reviews" DROP COLUMN "artisan_reply"`,
    );
    await queryRunner.query(`ALTER TABLE "reviews" DROP COLUMN "edited_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_reviews_status"`);
    await queryRunner.query(
      `ALTER TABLE "reviews" DROP CONSTRAINT "chk_reviews_status"`,
    );
    await queryRunner.query(`ALTER TABLE "reviews" DROP COLUMN "status"`);
  }
}
