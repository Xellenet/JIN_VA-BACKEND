import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payout name check: why a payout was held after the name on the artisan's
 * payout account was checked before the transfer, and when a check that
 * couldn't be made is retried.
 *
 * - `payout_hold_reason`: 'payout_name_mismatch' | 'payout_account_not_found'
 *   | 'payout_check_pending', or null (no hold). Set only while the payment
 *   is PENDING_TRANSFER; cleared when a transfer starts.
 * - `payout_check_attempts`: checks that couldn't be made in a row.
 * - `payout_check_next_at`: when the scheduler retries a pending check; null
 *   when nothing is scheduled (including after the retry cap).
 * - `payout_hold_notified_at`: when the artisan was told about a hold, so
 *   they are told once per payment, however often it is retried.
 *
 * Additive only: existing rows get null / 0 and keep their behaviour.
 */
export class AddPaymentPayoutHold1783310000000 implements MigrationInterface {
  name = 'AddPaymentPayoutHold1783310000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD COLUMN IF NOT EXISTS "payout_hold_reason" VARCHAR(40) NULL,
        ADD COLUMN IF NOT EXISTS "payout_check_attempts" INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "payout_check_next_at" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "payout_hold_notified_at" TIMESTAMPTZ NULL
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_payments_payout_check_next_at" ON "payments" ("payout_check_next_at") WHERE "payout_hold_reason" = 'payout_check_pending'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_payments_payout_check_next_at"`,
    );
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP COLUMN IF EXISTS "payout_hold_notified_at",
        DROP COLUMN IF EXISTS "payout_check_next_at",
        DROP COLUMN IF EXISTS "payout_check_attempts",
        DROP COLUMN IF EXISTS "payout_hold_reason"
    `);
  }
}
