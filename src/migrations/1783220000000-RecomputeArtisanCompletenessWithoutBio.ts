import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * B2 backfill (google-signup-prefill): recomputes `is_profile_complete` for
 * every existing artisan profile now that **bio is no longer required**.
 *
 * `ArtisansService.computeProfileCompleteness()` dropped `bio` from its rule,
 * but the flag is persisted and only recomputed on a profile write, so an
 * artisan who has a rate, a location and a service — and is hidden from
 * search only for lack of a bio — would stay hidden until they next saved
 * their profile. This repairs them on deploy, the same way
 * `BackfillArtisanProfileCompleteness1783190000000` did for C2.2.
 *
 * The predicate is a SQL transcription of the new rule: hourly rate,
 * non-blank location, at least one linked service. Like the earlier backfill
 * it is a dated snapshot, not the source of truth.
 *
 * The log line reports how many artisans became visible, by count only.
 */
export class RecomputeArtisanCompletenessWithoutBio1783220000000
  implements MigrationInterface
{
  name = 'RecomputeArtisanCompletenessWithoutBio1783220000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const changed = await this.recompute(queryRunner, false);
    const nowVisible = changed.filter((row) => row.is_profile_complete).length;
    console.log(
      `[${this.name}] recomputed is_profile_complete without bio: ` +
        `${changed.length} profile(s) changed, ${nowVisible} newly searchable`,
    );
  }

  /**
   * Reverts to the previous rule (bio required as well), recomputed from the
   * data itself rather than from a snapshot — so the result is exactly what
   * the old application code would compute for the same rows.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const changed = await this.recompute(queryRunner, true);
    console.log(
      `[${this.name}] down(): recomputed is_profile_complete with bio required: ` +
        `${changed.length} profile(s) changed`,
    );
  }

  private async recompute(
    queryRunner: QueryRunner,
    requireBio: boolean,
  ): Promise<Array<{ id: number; is_profile_complete: boolean }>> {
    const bioClause = requireBio
      ? `p."bio" IS NOT NULL AND btrim(p."bio") <> '' AND`
      : '';
    const result: unknown = await queryRunner.query(`
      UPDATE "artisan_profiles" ap
         SET "is_profile_complete" = computed.is_complete
        FROM (
              SELECT p."id",
                     (
                       ${bioClause}
                       p."hourly_rate" IS NOT NULL
                       AND p."location" IS NOT NULL AND btrim(p."location") <> ''
                       AND EXISTS (
                             SELECT 1
                               FROM "artisan_profile_services" aps
                              WHERE aps."artisan_profile_id" = p."id"
                           )
                     ) AS is_complete
                FROM "artisan_profiles" p
             ) AS computed
       WHERE ap."id" = computed."id"
         AND ap."is_profile_complete" IS DISTINCT FROM computed.is_complete
      RETURNING ap."id", ap."is_profile_complete"
    `);
    // pg returns UPDATE … RETURNING through TypeORM as [rows, count].
    const rows: unknown =
      Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
    return Array.isArray(rows)
      ? (rows as Array<{ id: number; is_profile_complete: boolean }>)
      : [];
  }
}
