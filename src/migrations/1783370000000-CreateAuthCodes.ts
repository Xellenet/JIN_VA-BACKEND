import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Auth v2: 6-digit email codes for sign-up, code login and password reset.
 *
 * - `auth_codes`: one row per live code. The code itself is never stored —
 *   only an HMAC-SHA-256 of it, bound to the purpose and the email hash. The
 *   email is stored only as a keyed hash too (`email_hash`), so a lookup works
 *   without the table holding the address. `user_id` is the account the code
 *   belongs to; a code is only ever written for a real account (a login code
 *   asked for an unknown address creates no row).
 * - `auth_code_requests`: one row per (email hash, purpose), holding the
 *   resend cooldown, the hourly cap and the failed-check counter. It is kept
 *   for every address that asks, registered or not, so the 429 and the
 *   "too many tries" answers are the same for an address with no account.
 *
 * Both tables are pruned hourly (`AuthCodeService.purgeExpired`). Additive and
 * idempotent; nothing existing is touched.
 */
export class CreateAuthCodes1783370000000 implements MigrationInterface {
  name = 'CreateAuthCodes1783370000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "auth_codes" (
        "id" SERIAL PRIMARY KEY,
        "user_id" INTEGER NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "email_hash" CHAR(64) NOT NULL,
        "purpose" VARCHAR(20) NOT NULL
          CONSTRAINT "chk_auth_codes_purpose"
          CHECK ("purpose" IN ('signup','login','password_reset')),
        "code_hash" CHAR(64) NOT NULL,
        "attempts" SMALLINT NOT NULL DEFAULT 0,
        "expires_at" TIMESTAMPTZ NOT NULL,
        "consumed_at" TIMESTAMPTZ NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_auth_codes_lookup" ON "auth_codes" ("email_hash", "purpose", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_auth_codes_expires" ON "auth_codes" ("expires_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_auth_codes_user" ON "auth_codes" ("user_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "auth_code_requests" (
        "email_hash" CHAR(64) NOT NULL,
        "purpose" VARCHAR(20) NOT NULL
          CONSTRAINT "chk_auth_code_requests_purpose"
          CHECK ("purpose" IN ('signup','login','password_reset')),
        "window_started_at" TIMESTAMPTZ NOT NULL,
        "sent_in_window" SMALLINT NOT NULL DEFAULT 0,
        "last_sent_at" TIMESTAMPTZ NOT NULL,
        "failed_checks" SMALLINT NOT NULL DEFAULT 0,
        CONSTRAINT "pk_auth_code_requests" PRIMARY KEY ("email_hash", "purpose")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_auth_code_requests_last_sent" ON "auth_code_requests" ("last_sent_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "auth_code_requests"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "auth_codes"`);
  }
}
