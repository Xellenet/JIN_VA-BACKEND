import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RA2: Bayesian weighted rating, stored alongside the existing plain
 * `average_rating`. Defaults to 0 for every existing artisan; backfilled the
 * next time `ReviewsService.refreshArtisanRatings` runs for that artisan
 * (create/edit/remove/restore) — not backfilled in bulk by this migration,
 * consistent with how `average_rating`/`total_reviews` are already
 * recalculated lazily rather than eagerly.
 */
export class AddArtisanWeightedRating1783080000000
  implements MigrationInterface
{
  name = 'AddArtisanWeightedRating1783080000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "artisan_profiles"
        ADD COLUMN "weighted_rating" NUMERIC(3,2) NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "artisan_profiles" DROP COLUMN "weighted_rating"`,
    );
  }
}
