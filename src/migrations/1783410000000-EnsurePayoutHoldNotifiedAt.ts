import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `payments.payout_hold_notified_at` where it is missing. An earlier
 * draft of `AddPaymentPayoutHold1783310000000` ran on some development
 * databases before that column was added to it, so those databases recorded
 * the migration as run without the column, and every payment query failed
 * ("column Payment.payout_hold_notified_at does not exist"). On any database
 * that ran the final version this changes nothing.
 */
export class EnsurePayoutHoldNotifiedAt1783410000000
  implements MigrationInterface
{
  name = 'EnsurePayoutHoldNotifiedAt1783410000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD COLUMN IF NOT EXISTS "payout_hold_notified_at" TIMESTAMPTZ NULL
    `);
  }

  public async down(): Promise<void> {
    // Nothing to undo: the column belongs to AddPaymentPayoutHold1783310000000,
    // whose own down() drops it.
  }
}
