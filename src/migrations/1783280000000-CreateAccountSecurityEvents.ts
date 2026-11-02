import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer Experience v2 (NFR-6.2): an append-only log of security-relevant
 * changes a user makes to their own account. Names only, never values.
 */
export class CreateAccountSecurityEvents1783280000000
  implements MigrationInterface
{
  name = 'CreateAccountSecurityEvents1783280000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "account_security_events" (
        "id" SERIAL PRIMARY KEY,
        "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "event" VARCHAR(60) NOT NULL
          CONSTRAINT "chk_account_security_events_event"
          CHECK ("event" IN ('payment_settings.updated','spending_report.exported','profile_photo.removed')),
        "fields_changed" TEXT[] NOT NULL DEFAULT '{}',
        "details" JSONB NULL,
        "ip" VARCHAR(45) NULL,
        "user_agent" VARCHAR(256) NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_account_security_events_user_created" ON "account_security_events" ("user_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_account_security_events_created" ON "account_security_events" ("created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "account_security_events"`);
  }
}
