import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * QA SRCH-09: `weighted_rating` is only written when a review is added or
 * moderated through the API, so ratings that arrived any other way (seed
 * data, older rows) kept 0.00 and sorted below artisans nobody had reviewed.
 *
 * Recomputes it for every reviewed artisan with the same Bayesian formula as
 * `ReviewsService.refreshArtisanRatings`: m = 10 (RATING_BAYESIAN_MIN_VOTES)
 * and C = the platform's mean review score (PlatformRatingCache, falling
 * back to its default of 3). Average and count are recomputed from the
 * reviews too, so all three agree. Unreviewed artisans are left as they are.
 */
export class BackfillWeightedRatings1783260000000
  implements MigrationInterface
{
  name = 'BackfillWeightedRatings1783260000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const updated = (await queryRunner.query(`
      WITH platform AS (
        SELECT COALESCE(ROUND(AVG(rating)::numeric, 2), 3) AS c FROM reviews
      ), stats AS (
        SELECT artisan_profile_id AS id, AVG(rating)::numeric AS avg, COUNT(*) AS n
          FROM reviews GROUP BY artisan_profile_id
      )
      UPDATE artisan_profiles ap
         SET average_rating = ROUND(stats.avg, 2),
             total_reviews = stats.n,
             weighted_rating = ROUND(
               (stats.n::numeric / (stats.n + 10)) * stats.avg
               + (10::numeric / (stats.n + 10)) * platform.c, 2)
        FROM stats, platform
       WHERE ap.id = stats.id
      RETURNING ap.id
    `)) as unknown[];
    console.log(
      `[${this.name}] recomputed weighted ratings for ${updated.length} reviewed artisan(s)`,
    );
  }

  public async down(): Promise<void> {
    // A recomputation from the reviews; there is nothing to undo.
  }
}
