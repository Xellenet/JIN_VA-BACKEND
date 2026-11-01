import { MigrationInterface, QueryRunner } from 'typeorm';

const OLD_EVENTS =
  "'payment_settings.updated','spending_report.exported','profile_photo.removed'";
const NEW_EVENTS = `${OLD_EVENTS},'payment_method.added','payment_method.removed'`;

/**
 * Saved payment methods for customers:
 * - `customer_payment_methods`: mobile money numbers (with the looked-up
 *   name) and reusable Paystack card authorizations. Secrets are encrypted
 *   by the application (AES-256-GCM); only labels are in the clear. One
 *   default per customer (partial unique index).
 * - `payment_charges`: each direct charge attempt with its own reference.
 * - `payments.save_card_requested`: the customer's opt-in, recorded at
 *   initialise, that the card used on the hosted checkout may be saved.
 * - Two more security event names.
 */
export class CreateCustomerPaymentMethods1783320000000
  implements MigrationInterface
{
  name = 'CreateCustomerPaymentMethods1783320000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "customer_payment_methods" (
        "id" SERIAL PRIMARY KEY,
        "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "type" VARCHAR(20) NOT NULL
          CONSTRAINT "chk_customer_payment_methods_type"
          CHECK ("type" IN ('mobile_money','card')),
        "is_default" BOOLEAN NOT NULL DEFAULT false,
        "network" VARCHAR(3) NULL
          CONSTRAINT "chk_customer_payment_methods_network"
          CHECK ("network" IN ('MTN','VOD','ATL')),
        "number_prefix" VARCHAR(3) NULL,
        "number_last4" VARCHAR(4) NULL,
        "account_name" VARCHAR(120) NULL,
        "name_verified" BOOLEAN NOT NULL DEFAULT false,
        "number_encrypted" TEXT NULL,
        "number_hash" VARCHAR(64) NULL,
        "card_brand" VARCHAR(30) NULL,
        "card_last4" VARCHAR(4) NULL,
        "exp_month" SMALLINT NULL,
        "exp_year" SMALLINT NULL,
        "card_bank" VARCHAR(100) NULL,
        "authorization_encrypted" TEXT NULL,
        "signature_hash" VARCHAR(64) NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "chk_customer_payment_methods_shape" CHECK (
          ("type" = 'mobile_money'
            AND "network" IS NOT NULL AND "number_encrypted" IS NOT NULL
            AND "number_hash" IS NOT NULL AND "number_last4" IS NOT NULL
            AND "authorization_encrypted" IS NULL)
          OR
          ("type" = 'card'
            AND "authorization_encrypted" IS NOT NULL AND "signature_hash" IS NOT NULL
            AND "card_last4" IS NOT NULL AND "number_encrypted" IS NULL)
        )
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_customer_payment_methods_default" ON "customer_payment_methods" ("user_id") WHERE "is_default"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_customer_payment_methods_number" ON "customer_payment_methods" ("user_id", "number_hash") WHERE "number_hash" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_customer_payment_methods_signature" ON "customer_payment_methods" ("user_id", "signature_hash") WHERE "signature_hash" IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "payment_charges" (
        "id" SERIAL PRIMARY KEY,
        "payment_id" INTEGER NOT NULL REFERENCES "payments"("id") ON DELETE CASCADE,
        "customer_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "reference" VARCHAR(100) NOT NULL UNIQUE,
        "method_type" VARCHAR(20) NOT NULL
          CONSTRAINT "chk_payment_charges_method_type"
          CHECK ("method_type" IN ('mobile_money','card')),
        "payment_method_id" INTEGER NULL
          REFERENCES "customer_payment_methods"("id") ON DELETE SET NULL,
        "status" VARCHAR(20) NOT NULL DEFAULT 'pending'
          CONSTRAINT "chk_payment_charges_status"
          CHECK ("status" IN ('pending','needs_otp','succeeded','failed','duplicate')),
        "action" VARCHAR(30) NULL,
        "message" VARCHAR(200) NULL,
        "last_verified_at" TIMESTAMPTZ NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_payment_charges_payment_status" ON "payment_charges" ("payment_id", "status")`,
    );

    await queryRunner.query(
      `ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "save_card_requested" BOOLEAN NOT NULL DEFAULT false`,
    );

    await queryRunner.query(
      `ALTER TABLE "account_security_events" DROP CONSTRAINT IF EXISTS "chk_account_security_events_event"`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_security_events" ADD CONSTRAINT "chk_account_security_events_event" CHECK ("event" IN (${NEW_EVENTS}))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "account_security_events" WHERE "event" IN ('payment_method.added','payment_method.removed')`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_security_events" DROP CONSTRAINT IF EXISTS "chk_account_security_events_event"`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_security_events" ADD CONSTRAINT "chk_account_security_events_event" CHECK ("event" IN (${OLD_EVENTS}))`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP COLUMN IF EXISTS "save_card_requested"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "payment_charges"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_payment_methods"`);
  }
}
