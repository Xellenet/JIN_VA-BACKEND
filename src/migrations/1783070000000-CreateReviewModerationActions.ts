import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AM5: append-only moderation audit log for flag/remove/restore actions.
 *
 * Deliberately has NO foreign keys to `reviews`, `users`, or
 * `artisan_profiles` — this table must remain a complete, readable record
 * even after a review (AM3's hard delete) or an actor/reviewer/artisan
 * account no longer exists. All identifying fields are plain snapshot
 * columns, not relations.
 */
export class CreateReviewModerationActions1783070000000
  implements MigrationInterface
{
  name = 'CreateReviewModerationActions1783070000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "review_moderation_actions" (
        "id"                 SERIAL PRIMARY KEY,
        "review_id"          INTEGER NOT NULL,
        "action"             VARCHAR(20) NOT NULL,
        "reason"             TEXT,
        "actor_id"           INTEGER NOT NULL,
        "actor_name"         VARCHAR,
        "actor_role"         VARCHAR(20),
        "reviewer_id"        INTEGER,
        "reviewer_name"      VARCHAR,
        "artisan_profile_id" INTEGER,
        "artisan_name"       VARCHAR,
        "rating"             NUMERIC(3,2),
        "review_excerpt"     VARCHAR(200),
        "created_at"         TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT "chk_review_moderation_actions_action"
          CHECK ("action" IN ('FLAG', 'REMOVE', 'RESTORE'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_review_moderation_actions_review_id"
        ON "review_moderation_actions" ("review_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_review_moderation_actions_created_at"
        ON "review_moderation_actions" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "review_moderation_actions"`);
  }
}
