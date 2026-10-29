import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One-off data repair for the rollback bug fixed alongside it
 * (qa-report.md QA-DC1-01 / security-report.md B2, `admin-disputes-closeout`).
 *
 * When a ruling's money action failed, `DisputesService.resolve()` rolled the
 * claim back by passing `undefined` for `outcome`, `resolution`,
 * `resolved_by_id` and `resolved_at`. TypeORM's `UpdateQueryBuilder` strips
 * `undefined` values from the statement, so only `status` was ever restored and
 * the row kept the verdict, the resolution note, the resolving admin and the
 * resolved timestamp of a ruling that never took effect.
 *
 * Fixing the write path stops new rows entering that state; it does nothing for
 * the rows already in it, and those rows are actively wrong in three places:
 * the admin queue renders a verdict badge on an `Open` dispute, the party read
 * hands both parties an `outcome` for a decision that was rolled back, and
 * `getResolutionMetrics` counts the dispute as resolved (`resolved_at IS NOT
 * NULL`) *and* as open, dragging a fabricated resolution time into the platform
 * SLA average.
 *
 * The predicate is the signature of the bug and nothing else: a dispute that is
 * still actionable (`OPEN`/`UNDER_REVIEW`) cannot legitimately carry a verdict
 * or a resolution timestamp, because the only writers of those columns are
 * `resolve()` (which also sets `RESOLVED`) and `close()` (which sets `CLOSED`),
 * and no code path returns a settled dispute to an actionable state.
 *
 * **The money columns are deliberately left alone.** Under the code that
 * produced these rows, `money_action`/`money_payment_id` were written only
 * *after* a movement the provider had already accepted, so clearing them could
 * erase the record of real money having moved — and that record is what stops a
 * sibling dispute on the same payment moving it a second time. Leaving them is
 * the fail-safe direction; the verdict columns are what mislead a reader.
 */
export class ClearRolledBackDisputeVerdicts1783210000000
  implements MigrationInterface
{
  name = 'ClearRolledBackDisputeVerdicts1783210000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const result: unknown = await queryRunner.query(`
      UPDATE "disputes"
         SET "outcome"        = NULL,
             "resolution"     = NULL,
             "resolved_by_id" = NULL,
             "resolved_at"    = NULL
       WHERE "status" IN ('OPEN', 'UNDER_REVIEW')
         AND (
               "outcome" IS NOT NULL
            OR "resolution" IS NOT NULL
            OR "resolved_by_id" IS NOT NULL
            OR "resolved_at" IS NOT NULL
         )
      RETURNING "id"
    `);

    const repaired = Array.isArray(result) ? result.length : 0;
    console.log(
      `[${this.name}] cleared rolled-back verdict data from ${repaired} dispute(s)`,
    );
  }

  /**
   * Not reversible, and a no-op rather than a lie.
   *
   * The values removed here described rulings that never took effect and were
   * not snapshotted anywhere, so there is nothing correct to roll back *to*.
   * Re-inserting a verdict onto an unresolved dispute would recreate the defect
   * this migration exists to repair.
   */
  public down(): Promise<void> {
    console.log(
      `[${this.name}] down() is a no-op: the cleared values described rulings that never took effect`,
    );
    return Promise.resolve();
  }
}
