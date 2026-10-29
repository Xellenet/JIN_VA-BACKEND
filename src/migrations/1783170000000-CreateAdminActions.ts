import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AT5: generic, append-only admin accountability log.
 *
 * Reuses `review_moderation_actions`' shape **exactly** — no foreign keys at
 * all, and every identifying value captured as a plain snapshot column at the
 * moment the action happens. The point of the table is to stay a complete,
 * readable record after the thing it describes (a user, a payment, a portfolio
 * item, a dispute) has been deleted, so a relation that could cascade away or
 * dangle would defeat it.
 *
 * It does **not** replace or absorb `review_moderation_actions`, which stays
 * as the reviews round built it.
 *
 * Retention is indefinite (Open Question 8, resolved) — append-only, no
 * expiry, no deletion path, because accountability is the whole purpose.
 */
export class CreateAdminActions1783170000000 implements MigrationInterface {
  name = 'CreateAdminActions1783170000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin_actions" (
        "id"             SERIAL PRIMARY KEY,
        "action"         VARCHAR(40) NOT NULL,
        "target_type"    VARCHAR(20) NOT NULL,
        "target_id"      INTEGER NOT NULL,
        "target_label"   VARCHAR(200),
        "reason"         TEXT,
        "actor_id"       INTEGER NOT NULL,
        "actor_name"     VARCHAR,
        "actor_email"    VARCHAR,
        "outcome"        VARCHAR(30),
        "money_action"   VARCHAR(20),
        "amount"         NUMERIC(10,2),
        "metadata"       JSONB,
        "created_at"     TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT "chk_admin_actions_target_type"
          CHECK ("target_type" IN ('USER', 'VERIFICATION', 'PORTFOLIO_ITEM', 'DISPUTE', 'PAYMENT'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_admin_actions_created_at"
        ON "admin_actions" ("created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_admin_actions_action"
        ON "admin_actions" ("action")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_admin_actions_actor_id"
        ON "admin_actions" ("actor_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_admin_actions_target"
        ON "admin_actions" ("target_type", "target_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "admin_actions"`);
  }
}
