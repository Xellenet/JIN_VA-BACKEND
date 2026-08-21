import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Security finding (reviews-ratings-favourites round 1, MEDIUM,
 * CWE-362/TOCTOU): closes a race in `ReviewsService.flag()` where
 * concurrent `POST /reviews/:id/flag` requests from the same actor could
 * both pass the app-level "already flagged by you" read-then-write check
 * before either commit, spamming `review_moderation_actions` with duplicate
 * FLAG rows for the same (review, actor) pair.
 *
 * A partial unique index makes the second concurrent insert fail at the DB
 * level (`23505`); `ReviewsService.flag()` now catches that and translates
 * it into the same `ConflictException` the app-level pre-check already
 * throws for the non-concurrent case.
 *
 * Scoped to `action = 'FLAG'` only — REMOVE/RESTORE rows are legitimately
 * repeatable for the same review by the same admin (e.g. flag -> restore ->
 * flag again -> restore again) and must not be constrained by this index.
 */
export class AddReviewModerationActionsFlagUniqueIndex1783090000000
  implements MigrationInterface
{
  name = 'AddReviewModerationActionsFlagUniqueIndex1783090000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_review_moderation_actions_flag_review_actor"
        ON "review_moderation_actions" ("review_id", "actor_id")
        WHERE "action" = 'FLAG'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."UQ_review_moderation_actions_flag_review_actor"`,
    );
  }
}
