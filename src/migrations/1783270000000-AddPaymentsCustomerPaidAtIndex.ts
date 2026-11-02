import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer experience v2 (B4): the customer spending report, the overview
 * rail and the paginated payment history all read one customer's payments by
 * paid date (`WHERE customer_id = $1 ... ORDER BY paid_at`). The existing
 * single-column `idx_payments_customer_id` finds the rows but not in date
 * order; this composite index serves both the filter and the window/order.
 * Additive only, so no existing row or query changes.
 */
export class AddPaymentsCustomerPaidAtIndex1783270000000
  implements MigrationInterface
{
  name = 'AddPaymentsCustomerPaidAtIndex1783270000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_payments_customer_id_paid_at" ON "payments" ("customer_id", "paid_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_payments_customer_id_paid_at"`,
    );
  }
}
