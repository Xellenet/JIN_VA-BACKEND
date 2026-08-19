import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePayments1782880000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "payments_status_enum" AS ENUM (
        'PENDING', 'HELD', 'PENDING_TRANSFER', 'RELEASED', 'REFUNDED', 'CANCELLED', 'FAILED'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "payments" (
        "id"                  SERIAL PRIMARY KEY,
        "job_id"              INTEGER       NOT NULL,
        "customer_id"         INTEGER       NOT NULL,
        "artisan_profile_id"  INTEGER       NOT NULL,
        "amount"              NUMERIC(10,2) NOT NULL,
        "platform_fee"        NUMERIC(10,2) NOT NULL,
        "artisan_amount"      NUMERIC(10,2) NOT NULL,
        "currency"            VARCHAR(3)    NOT NULL DEFAULT 'GHS',
        "status"              "payments_status_enum" NOT NULL DEFAULT 'PENDING',
        "reference"           VARCHAR(100)  NOT NULL UNIQUE,
        "authorization_url"   TEXT,
        "access_code"         VARCHAR(100),
        "channel"             VARCHAR(30),
        "transfer_reference"  VARCHAR(100),
        "transfer_code"       VARCHAR(100),
        "paid_at"             TIMESTAMPTZ,
        "released_at"         TIMESTAMPTZ,
        "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT "fk_payment_job"            FOREIGN KEY ("job_id")             REFERENCES "jobs"("id")             ON DELETE CASCADE,
        CONSTRAINT "fk_payment_customer"       FOREIGN KEY ("customer_id")        REFERENCES "users"("id")            ON DELETE CASCADE,
        CONSTRAINT "fk_payment_artisan"        FOREIGN KEY ("artisan_profile_id") REFERENCES "artisan_profiles"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "idx_payments_job_id"      ON "payments" ("job_id")`);
    await queryRunner.query(`CREATE INDEX "idx_payments_customer_id" ON "payments" ("customer_id")`);
    await queryRunner.query(`CREATE INDEX "idx_payments_status"      ON "payments" ("status")`);
    await queryRunner.query(`CREATE INDEX "idx_payments_reference"   ON "payments" ("reference")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "payments"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "payments_status_enum"`);
  }
}
