import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * qa-report.md LOW finding ("partial-refund amount isn't persisted/shown
 * distinctly") + security-report.md finding #4 (refund amount validated
 * against the original total, not the remaining refundable balance): adds a
 * `refunded_amount` column so `adminRefund` can track cumulative refunds per
 * payment instead of only ever recording a boolean-ish REFUNDED status.
 */
export class AddPaymentRefundedAmount1783040000000
  implements MigrationInterface
{
  name = 'AddPaymentRefundedAmount1783040000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payments"
      ADD COLUMN "refunded_amount" NUMERIC(10,2) NOT NULL DEFAULT 0
    `);
    // Best-effort backfill: any row already sitting at REFUNDED today has no
    // record of whether it was a full or partial refund, so we can only
    // assume the full amount was refunded (the pre-existing, more common
    // case) rather than leaving it at 0, which would misleadingly read as
    // "not refunded" once the column starts being displayed.
    await queryRunner.query(`
      UPDATE "payments" SET "refunded_amount" = "amount" WHERE "status" = 'REFUNDED'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "payments" DROP COLUMN "refunded_amount"
    `);
  }
}
