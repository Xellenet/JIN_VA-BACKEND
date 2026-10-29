import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DR1/DR2/DR4/DR5: turns a dispute resolution from a free-text note into a
 * recorded verdict with a money consequence, and gives the counterparty a
 * place to answer the claim.
 *
 * Every column is nullable: disputes filed before this migration have no
 * category, no verdict and no response, and must stay readable exactly as
 * they are. `category` is required by `CreateDisputeDto` on new disputes
 * only, and reads fall back to `OTHER` for legacy rows.
 *
 * `money_payment_id` is intentionally **not** foreign-keyed to `payments` —
 * it records which payment a ruling acted on, and that record must outlive
 * the payment row (same reasoning as `review_moderation_actions`).
 */
export class AddDisputeOutcomeCategoryAndResponse1783140000000
  implements MigrationInterface
{
  name = 'AddDisputeOutcomeCategoryAndResponse1783140000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "disputes"
        ADD COLUMN IF NOT EXISTS "category"         VARCHAR(30),
        ADD COLUMN IF NOT EXISTS "response"         TEXT,
        ADD COLUMN IF NOT EXISTS "responded_by_id"  INTEGER,
        ADD COLUMN IF NOT EXISTS "responded_at"     TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "outcome"          VARCHAR(20),
        ADD COLUMN IF NOT EXISTS "money_action"     VARCHAR(20),
        ADD COLUMN IF NOT EXISTS "money_amount"     NUMERIC(10,2),
        ADD COLUMN IF NOT EXISTS "money_payment_id" INTEGER
    `);

    await queryRunner.query(`
      ALTER TABLE "disputes"
        ADD CONSTRAINT "fk_disputes_responded_by"
          FOREIGN KEY ("responded_by_id") REFERENCES "users" ("id") ON DELETE SET NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "disputes"
        ADD CONSTRAINT "chk_disputes_outcome"
          CHECK ("outcome" IS NULL OR "outcome" IN ('REFUND_CLIENT', 'RELEASE_ARTISAN', 'MUTUAL'))
    `);
    await queryRunner.query(`
      ALTER TABLE "disputes"
        ADD CONSTRAINT "chk_disputes_money_action"
          CHECK ("money_action" IS NULL OR "money_action" IN ('NONE', 'REFUND', 'RELEASE'))
    `);
    await queryRunner.query(`
      ALTER TABLE "disputes"
        ADD CONSTRAINT "chk_disputes_category"
          CHECK ("category" IS NULL OR "category" IN (
            'WORK_NOT_COMPLETED', 'WORK_QUALITY', 'ARTISAN_NO_SHOW',
            'CLIENT_NO_ACCESS', 'PAYMENT_AMOUNT', 'PROPERTY_DAMAGE', 'OTHER'
          ))
    `);

    // DQ1/DQ2: the admin queue filters and counts on these two columns on
    // every page load, and DR6's SLA aggregate scans created_at/resolved_at.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_disputes_status" ON "disputes" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_disputes_category" ON "disputes" ("category")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_disputes_created_at" ON "disputes" ("created_at")
    `);

    // DR2: hard backstop against two disputes over one payment both moving
    // money. The service also guards this in an application-level
    // transaction (and re-checks the payment's own status), but a unique
    // index is the only guarantee that survives two concurrent requests
    // landing on two different app instances.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_disputes_money_payment"
        ON "disputes" ("money_payment_id")
        WHERE "money_payment_id" IS NOT NULL AND "money_action" <> 'NONE'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_disputes_money_payment"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_disputes_created_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_disputes_category"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_disputes_status"`);
    await queryRunner.query(`
      ALTER TABLE "disputes"
        DROP CONSTRAINT IF EXISTS "chk_disputes_category",
        DROP CONSTRAINT IF EXISTS "chk_disputes_money_action",
        DROP CONSTRAINT IF EXISTS "chk_disputes_outcome",
        DROP CONSTRAINT IF EXISTS "fk_disputes_responded_by"
    `);
    await queryRunner.query(`
      ALTER TABLE "disputes"
        DROP COLUMN IF EXISTS "money_payment_id",
        DROP COLUMN IF EXISTS "money_amount",
        DROP COLUMN IF EXISTS "money_action",
        DROP COLUMN IF EXISTS "outcome",
        DROP COLUMN IF EXISTS "responded_at",
        DROP COLUMN IF EXISTS "responded_by_id",
        DROP COLUMN IF EXISTS "response",
        DROP COLUMN IF EXISTS "category"
    `);
  }
}
