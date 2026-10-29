import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * security/qa BLOCKER-2 fix: `TRANSFER_FAILED` was added to the TypeScript
 * `PaymentStatus` enum (and is used throughout `payments.service.ts`'s
 * retry/failed-transfer logic) but was never added to the native Postgres
 * enum type created by `1782880000000-CreatePayments.ts`. Every query that
 * bound `'TRANSFER_FAILED'` as a value for the `payments.status` column
 * (e.g. `retryPendingTransfer`'s `status: In([...])` filter, or
 * `onTransferFailed` saving the status) failed at bind time with
 * `22P02: invalid input value for enum payments_status_enum`.
 *
 * Postgres 12+ allows `ALTER TYPE ... ADD VALUE` inside a transaction as
 * long as the new value isn't *used* in that same transaction — which is
 * the case here, so this is safe to run as part of the normal migration
 * transaction.
 */
export class AddTransferFailedPaymentStatus1783030000000
  implements MigrationInterface
{
  name = 'AddTransferFailedPaymentStatus1783030000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "payments_status_enum" ADD VALUE IF NOT EXISTS 'TRANSFER_FAILED'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres has no `DROP VALUE` for enum types — the only way back is to
    // rebuild the type. Any row currently sitting in TRANSFER_FAILED is
    // remapped to FAILED (the closest existing terminal-ish status) so the
    // rebuild doesn't fail on a value the narrower type can't represent.
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" TYPE varchar USING "status"::text`,
    );
    await queryRunner.query(
      `UPDATE "payments" SET "status" = 'FAILED' WHERE "status" = 'TRANSFER_FAILED'`,
    );
    await queryRunner.query(`DROP TYPE "payments_status_enum"`);
    await queryRunner.query(`
      CREATE TYPE "payments_status_enum" AS ENUM (
        'PENDING', 'HELD', 'PENDING_TRANSFER', 'RELEASED', 'REFUNDED', 'CANCELLED', 'FAILED'
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" TYPE "payments_status_enum" USING "status"::"payments_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" SET DEFAULT 'PENDING'`,
    );
  }
}
