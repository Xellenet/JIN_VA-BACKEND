import { MigrationInterface, QueryRunner } from 'typeorm';

const OLD_STATUSES = `'pending','needs_otp','succeeded','failed','duplicate'`;
const NEW_STATUSES = `'pending','needs_otp','hosted_open','succeeded','failed','expired','cancelled','duplicate'`;
const ACTIVE = `'pending','needs_otp','hosted_open'`;

/**
 * Idempotent job payments:
 *
 * - `payment_charges` now holds every attempt to pay a job: the hosted
 *   checkout (`method_type = 'hosted'`, with its stored authorization URL
 *   and access code) as well as saved mobile money and card charges.
 * - At most one active attempt (`pending`, `needs_otp`, `hosted_open`) per
 *   payment, enforced by a partial unique index. A job has one payment row,
 *   so this is one active attempt per job.
 * - `expired` / `cancelled`: an attempt released after Paystack said it did
 *   not succeed, or cancelled by an account deletion request.
 * - A second successful charge for a paid job is refunded automatically; the
 *   refund state lives on its attempt row (`refund_*`), so one reference can
 *   only ever have one refund.
 * - `payments.paid_reference`: the reference whose money the job holds,
 *   which is never refunded as a duplicate.
 * - `idempotency_keys`: the first response to a POST carrying an
 *   `Idempotency-Key`, replayed for 24 hours.
 *
 * Existing rows: an open hosted checkout on a still-pending payment becomes
 * a `hosted_open` attempt with the payment's own reference; only the newest
 * active attempt of a payment stays active (older ones become `expired`).
 */
export class PaymentAttemptsIdempotency1783330000000
  implements MigrationInterface
{
  name = 'PaymentAttemptsIdempotency1783330000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payment_charges" DROP CONSTRAINT IF EXISTS "chk_payment_charges_method_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_charges" ADD CONSTRAINT "chk_payment_charges_method_type" CHECK ("method_type" IN ('mobile_money','card','hosted'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_charges" DROP CONSTRAINT IF EXISTS "chk_payment_charges_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_charges" ADD CONSTRAINT "chk_payment_charges_status" CHECK ("status" IN (${NEW_STATUSES}))`,
    );
    await queryRunner.query(`
      ALTER TABLE "payment_charges"
        ADD COLUMN IF NOT EXISTS "authorization_url" TEXT NULL,
        ADD COLUMN IF NOT EXISTS "access_code" VARCHAR(100) NULL,
        ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "refund_status" VARCHAR(20) NULL,
        ADD COLUMN IF NOT EXISTS "refund_id" VARCHAR(64) NULL,
        ADD COLUMN IF NOT EXISTS "refund_amount" NUMERIC(10,2) NULL,
        ADD COLUMN IF NOT EXISTS "refund_attempts" SMALLINT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "refund_next_at" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "refunded_at" TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS "channel" VARCHAR(30) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "payment_charges"
        ADD CONSTRAINT "chk_payment_charges_refund_status"
        CHECK ("refund_status" IS NULL OR "refund_status" IN ('pending','processing','requested','processed','failed'))
    `);
    // Only a duplicate payment is ever refunded automatically.
    await queryRunner.query(`
      ALTER TABLE "payment_charges"
        ADD CONSTRAINT "chk_payment_charges_refund_only_duplicate"
        CHECK ("refund_status" IS NULL OR "status" = 'duplicate')
    `);

    await queryRunner.query(
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "paid_reference" VARCHAR(100) NULL`,
    );
    // The reference that paid: a succeeded saved-method charge, else the
    // payment's own (hosted) reference for any payment that was paid.
    await queryRunner.query(`
      UPDATE "payments" p SET "paid_reference" = c."reference"
      FROM "payment_charges" c
      WHERE c."payment_id" = p."id" AND c."status" = 'succeeded' AND p."paid_reference" IS NULL
    `);
    await queryRunner.query(`
      UPDATE "payments" SET "paid_reference" = "reference"
      WHERE "paid_reference" IS NULL
        AND "status" IN ('HELD','PENDING_TRANSFER','TRANSFER_FAILED','RELEASED','REFUNDED')
    `);

    // An open hosted checkout becomes an attempt (its own reference).
    await queryRunner.query(`
      INSERT INTO "payment_charges"
        ("payment_id","customer_id","reference","method_type","status","action",
         "authorization_url","access_code","created_at","updated_at","expires_at")
      SELECT p."id", p."customer_id", p."reference", 'hosted', 'hosted_open', 'continue_checkout',
             p."authorization_url", p."access_code", p."updated_at", NOW(),
             p."updated_at" + interval '30 minutes'
      FROM "payments" p
      WHERE p."status" = 'PENDING' AND p."authorization_url" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM "payment_charges" c WHERE c."reference" = p."reference")
    `);
    await queryRunner.query(`
      UPDATE "payment_charges" SET "expires_at" = "created_at" + interval '10 minutes'
      WHERE "expires_at" IS NULL
    `);
    // Keep the newest active attempt of each payment; the rest are expired.
    await queryRunner.query(`
      UPDATE "payment_charges" c SET "status" = 'expired', "action" = NULL
      WHERE c."status" IN (${ACTIVE})
        AND EXISTS (
          SELECT 1 FROM "payment_charges" n
          WHERE n."payment_id" = c."payment_id" AND n."status" IN (${ACTIVE})
            AND (n."created_at", n."id") > (c."created_at", c."id")
        )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_payment_charges_one_active" ON "payment_charges" ("payment_id") WHERE "status" IN (${ACTIVE})`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_payment_charges_refund_due" ON "payment_charges" ("refund_next_at") WHERE "refund_status" IN ('pending','processing')`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_payment_charges_customer_active" ON "payment_charges" ("customer_id") WHERE "status" IN (${ACTIVE})`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "idempotency_keys" (
        "id" SERIAL PRIMARY KEY,
        "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "key" VARCHAR(64) NOT NULL,
        "route" VARCHAR(80) NOT NULL,
        "fingerprint" CHAR(64) NOT NULL,
        "state" VARCHAR(12) NOT NULL DEFAULT 'in_progress'
          CONSTRAINT "chk_idempotency_keys_state"
          CHECK ("state" IN ('in_progress','completed')),
        "response_status" SMALLINT NULL,
        "response_body" JSONB NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "expires_at" TIMESTAMPTZ NOT NULL
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_idempotency_keys_user_route_key" ON "idempotency_keys" ("user_id","route","key")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_idempotency_keys_expires_at" ON "idempotency_keys" ("expires_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "idempotency_keys"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_payment_charges_customer_active"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_payment_charges_refund_due"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_payment_charges_one_active"`,
    );
    // Hosted attempts go; the payment row still has its checkout session.
    await queryRunner.query(
      `DELETE FROM "payment_charges" WHERE "method_type" = 'hosted'`,
    );
    await queryRunner.query(
      `UPDATE "payment_charges" SET "status" = 'failed' WHERE "status" IN ('expired','cancelled','hosted_open')`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP COLUMN IF EXISTS "paid_reference"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_charges" DROP CONSTRAINT IF EXISTS "chk_payment_charges_refund_only_duplicate"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_charges" DROP CONSTRAINT IF EXISTS "chk_payment_charges_refund_status"`,
    );
    await queryRunner.query(`
      ALTER TABLE "payment_charges"
        DROP COLUMN IF EXISTS "authorization_url",
        DROP COLUMN IF EXISTS "access_code",
        DROP COLUMN IF EXISTS "expires_at",
        DROP COLUMN IF EXISTS "refund_status",
        DROP COLUMN IF EXISTS "refund_id",
        DROP COLUMN IF EXISTS "refund_amount",
        DROP COLUMN IF EXISTS "refund_attempts",
        DROP COLUMN IF EXISTS "refund_next_at",
        DROP COLUMN IF EXISTS "refunded_at",
        DROP COLUMN IF EXISTS "channel"
    `);
    await queryRunner.query(
      `ALTER TABLE "payment_charges" DROP CONSTRAINT IF EXISTS "chk_payment_charges_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_charges" ADD CONSTRAINT "chk_payment_charges_status" CHECK ("status" IN (${OLD_STATUSES}))`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_charges" DROP CONSTRAINT IF EXISTS "chk_payment_charges_method_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_charges" ADD CONSTRAINT "chk_payment_charges_method_type" CHECK ("method_type" IN ('mobile_money','card'))`,
    );
  }
}
