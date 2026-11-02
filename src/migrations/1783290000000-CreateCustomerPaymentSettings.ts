import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer Experience v2 (B5): one row per customer holding the preferred
 * checkout method and mobile money network. Created on the first real save.
 * There is deliberately no mobile money number column (Q6 = No, PR-1).
 */
export class CreateCustomerPaymentSettings1783290000000
  implements MigrationInterface
{
  name = 'CreateCustomerPaymentSettings1783290000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "customer_payment_settings" (
        "id" SERIAL PRIMARY KEY,
        "user_id" INTEGER NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE CASCADE,
        "preferred_channel" VARCHAR(20) NULL
          CONSTRAINT "chk_customer_payment_settings_channel"
          CHECK ("preferred_channel" IN ('mobile_money','card')),
        "momo_network" VARCHAR(10) NULL
          CONSTRAINT "chk_customer_payment_settings_network"
          CHECK ("momo_network" IN ('MTN','TELECEL','AT')),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "customer_payment_settings"`);
  }
}
