import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C2.2 backfill: recomputes `is_profile_complete` for every existing artisan
 * profile.
 *
 * Why this is needed at all: `PATCH /users/me/artisan-profile` — the route
 * both the artisan Profile page and the Settings page actually save through —
 * never recomputed the flag. Only the `/artisans/me` routes did. So any
 * artisan who filled in their bio, hourly rate or service area through the UI
 * and did not subsequently add or remove a service is sitting on a stale
 * `false` right now, invisible in customer search with no way to discover why.
 * Fixing the write path only helps artisans who edit their profile *again*;
 * this repairs the ones already in that state.
 *
 * Runs as a migration rather than an operator-invoked script deliberately: it
 * is a one-off data repair that must happen on deploy, and a script someone
 * has to remember to run is a script that gets forgotten.
 *
 * The predicate below is a direct SQL transcription of
 * `ArtisansService.computeProfileCompleteness()` at the time of writing — bio,
 * hourly rate, location, and at least one linked service, with blank-but-not
 * -null text treated as missing (matching that function's `?.trim()` checks).
 * It is intentionally **not** the source of truth: application code has
 * exactly one definition of "complete" and this is a historical snapshot of
 * it. If that definition ever changes, this migration stays as it is (it
 * describes what was repaired on this date) and the change needs its own
 * backfill.
 */
export class BackfillArtisanProfileCompleteness1783190000000
  implements MigrationInterface
{
  name = 'BackfillArtisanProfileCompleteness1783190000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const result: unknown = await queryRunner.query(`
      UPDATE "artisan_profiles" ap
         SET "is_profile_complete" = computed.is_complete
        FROM (
              SELECT p."id",
                     (
                       p."bio" IS NOT NULL AND btrim(p."bio") <> ''
                       AND p."hourly_rate" IS NOT NULL
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

    const corrected = Array.isArray(result) ? result.length : 0;
    console.log(
      `[${this.name}] corrected is_profile_complete on ${corrected} artisan profile(s)`,
    );
  }

  /**
   * Not reversible, and deliberately a no-op rather than a lie.
   *
   * The previous per-row values were wrong (that is the entire reason for this
   * migration) and were not snapshotted anywhere, so there is nothing correct
   * to roll back *to*. Blanket-resetting the column to `false` would hide
   * every correctly-complete artisan from search, which is strictly worse than
   * leaving accurate data in place.
   */
  public down(): Promise<void> {
    console.log(
      `[${this.name}] down() is a no-op: the pre-backfill values were incorrect and were not retained`,
    );
    return Promise.resolve();
  }
}
