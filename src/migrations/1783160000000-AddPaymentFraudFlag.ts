import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AT7: a manual fraud-review marker on a payment, with a mandatory reason.
 *
 * Deliberately **separate from `payments.status`**: a payment can be both
 * `RELEASED` and flagged, and folding this into the status column would fork
 * the settled payment-status vocabulary (`HELD` → "Withheld") that the
 * frontend's shared `paymentStatusConfig` map is the single source for.
 * Marking, visibility and auditing only — no enforcement effect (Open
 * Question 9, resolved).
 */
export class AddPaymentFraudFlag1783160000000 implements MigrationInterface {
  name = 'AddPaymentFraudFlag1783160000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD COLUMN IF NOT EXISTS "fraud_flagged"         BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS "fraud_flag_reason"     TEXT,
        ADD COLUMN IF NOT EXISTS "fraud_flagged_at"      TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "fraud_flagged_by_id"   INTEGER
    `);

    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD CONSTRAINT "fk_payments_fraud_flagged_by"
          FOREIGN KEY ("fraud_flagged_by_id") REFERENCES "users" ("id") ON DELETE SET NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_payments_fraud_flagged"
        ON "payments" ("fraud_flagged") WHERE "fraud_flagged" = TRUE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_payments_fraud_flagged"`,
    );
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP CONSTRAINT IF EXISTS "fk_payments_fraud_flagged_by"
    `);
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP COLUMN IF EXISTS "fraud_flagged_by_id",
        DROP COLUMN IF EXISTS "fraud_flagged_at",
        DROP COLUMN IF EXISTS "fraud_flag_reason",
        DROP COLUMN IF EXISTS "fraud_flagged"
    `);
  }
}
