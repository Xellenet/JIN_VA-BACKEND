import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * auth-identity-hardening remediation:
 * - F7: `service_radius_km` — artisan's service radius (kilometres).
 * - F6: `cancellation_policy` — free-text cancellation policy.
 * - F3: `is_profile_complete` — recomputed on every profile/service mutation
 *   thereafter; gates visibility in `GET /artisans` search results. Backfilled
 *   here for existing rows using the same rule as
 *   `ArtisansService.computeProfileCompleteness` (bio + hourlyRate + location +
 *   at least one service) so already-complete artisans don't silently vanish
 *   from search the moment this ships.
 */
export class AddArtisanProfileHardeningFields1782900000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "artisan_profiles"
        ADD COLUMN IF NOT EXISTS "service_radius_km"   INT,
        ADD COLUMN IF NOT EXISTS "cancellation_policy" TEXT,
        ADD COLUMN IF NOT EXISTS "is_profile_complete" BOOLEAN NOT NULL DEFAULT false
    `);

    await queryRunner.query(`
      UPDATE "artisan_profiles" ap
      SET "is_profile_complete" = (
        COALESCE(NULLIF(TRIM(ap.bio), ''), NULL) IS NOT NULL
        AND ap.hourly_rate IS NOT NULL
        AND COALESCE(NULLIF(TRIM(ap.location), ''), NULL) IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM artisan_profile_services aps WHERE aps.artisan_profile_id = ap.id
        )
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "artisan_profiles"
        DROP COLUMN IF EXISTS "service_radius_km",
        DROP COLUMN IF EXISTS "cancellation_policy",
        DROP COLUMN IF EXISTS "is_profile_complete"
    `);
  }
}
