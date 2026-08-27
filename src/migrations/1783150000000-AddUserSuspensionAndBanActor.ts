import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AT2/AT3: adds the reversible suspension state PRD §5.13 requires ("activate,
 * suspend, or permanently ban" — the platform had only the permanent ban), and
 * captures the acting admin on both ban and suspension, which was previously
 * recorded nowhere (`banned_at` had no actor).
 *
 * Suspension is deliberately a **second, independent boolean** rather than a
 * status enum replacing `is_banned`: the two states can legitimately coexist
 * (a suspended account can later be banned outright) and re-modelling
 * `is_banned` would break the auth strategy's login block, the artisan search
 * filter and the admin list filter all at once.
 */
export class AddUserSuspensionAndBanActor1783150000000
  implements MigrationInterface
{
  name = 'AddUserSuspensionAndBanActor1783150000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "is_suspended"       BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS "suspended_at"       TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "suspended_by_id"    INTEGER,
        ADD COLUMN IF NOT EXISTS "suspension_reason"  TEXT,
        ADD COLUMN IF NOT EXISTS "banned_by_id"       INTEGER
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
        ADD CONSTRAINT "fk_users_suspended_by"
          FOREIGN KEY ("suspended_by_id") REFERENCES "users" ("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD CONSTRAINT "fk_users_banned_by"
          FOREIGN KEY ("banned_by_id") REFERENCES "users" ("id") ON DELETE SET NULL
    `);

    // AT3: the admin user list filters on account status and join date.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_users_is_suspended" ON "users" ("is_suspended")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_users_created_at" ON "users" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_created_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_is_suspended"`);
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP CONSTRAINT IF EXISTS "fk_users_banned_by",
        DROP CONSTRAINT IF EXISTS "fk_users_suspended_by"
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "banned_by_id",
        DROP COLUMN IF EXISTS "suspension_reason",
        DROP COLUMN IF EXISTS "suspended_by_id",
        DROP COLUMN IF EXISTS "suspended_at",
        DROP COLUMN IF EXISTS "is_suspended"
    `);
  }
}
