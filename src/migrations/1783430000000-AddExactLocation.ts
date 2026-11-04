import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Exact location (Uber-style pin) for jobs and bookings.
 *
 * - `jobs.latitude` / `jobs.longitude` already existed as numeric(10,2), which
 *   rounds to about 1 km. They become numeric(9,6) (about 0.1 m). Nothing has
 *   written them so far; any value outside the world's ranges, or a half pair,
 *   is cleared first so the type change and the pair check cannot fail.
 * - `location_accuracy_m`: the GPS accuracy (metres) when the pin came from GPS.
 * - `landmark`: an optional "opposite the post office, blue gate" note.
 * - `bookings` had no location at all: it gets the text `location` (the area
 *   label) and the same four fields.
 *
 * Privacy (Act 843): these are someone's home. The API only returns the
 * coordinates and landmark to the owner, the hired artisan and admins.
 *
 * Idempotent (IF NOT EXISTS, guarded constraints, a type change to the same
 * type is a no-op), because the dev servers run migrations on start and an
 * interrupted run must be safe to repeat.
 */
export class AddExactLocation1783430000000 implements MigrationInterface {
  name = 'AddExactLocation1783430000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Clear anything that would not fit numeric(9,6) or the pair rule.
    await queryRunner.query(`
      UPDATE "jobs"
         SET "latitude" = NULL, "longitude" = NULL
       WHERE ("latitude" IS NULL) <> ("longitude" IS NULL)
          OR "latitude" < -90 OR "latitude" > 90
          OR "longitude" < -180 OR "longitude" > 180
    `);
    await queryRunner.query(`
      ALTER TABLE "jobs"
        ALTER COLUMN "latitude" TYPE numeric(9,6) USING "latitude"::numeric(9,6),
        ALTER COLUMN "longitude" TYPE numeric(9,6) USING "longitude"::numeric(9,6)
    `);
    await queryRunner.query(`
      ALTER TABLE "jobs"
        ADD COLUMN IF NOT EXISTS "location_accuracy_m" integer NULL,
        ADD COLUMN IF NOT EXISTS "landmark" character varying(140) NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "bookings"
        ADD COLUMN IF NOT EXISTS "location" character varying(200) NULL,
        ADD COLUMN IF NOT EXISTS "latitude" numeric(9,6) NULL,
        ADD COLUMN IF NOT EXISTS "longitude" numeric(9,6) NULL,
        ADD COLUMN IF NOT EXISTS "location_accuracy_m" integer NULL,
        ADD COLUMN IF NOT EXISTS "landmark" character varying(140) NULL
    `);

    for (const table of ['jobs', 'bookings']) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'CHK_${table}_coordinates_pair'
          ) THEN
            ALTER TABLE "${table}"
              ADD CONSTRAINT "CHK_${table}_coordinates_pair"
              CHECK (("latitude" IS NULL) = ("longitude" IS NULL));
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'CHK_${table}_location_accuracy'
          ) THEN
            ALTER TABLE "${table}"
              ADD CONSTRAINT "CHK_${table}_location_accuracy"
              CHECK ("location_accuracy_m" IS NULL OR "location_accuracy_m" >= 0);
          END IF;
        END
        $$
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['jobs', 'bookings']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP CONSTRAINT IF EXISTS "CHK_${table}_coordinates_pair",
          DROP CONSTRAINT IF EXISTS "CHK_${table}_location_accuracy"
      `);
    }
    await queryRunner.query(`
      ALTER TABLE "bookings"
        DROP COLUMN IF EXISTS "landmark",
        DROP COLUMN IF EXISTS "location_accuracy_m",
        DROP COLUMN IF EXISTS "longitude",
        DROP COLUMN IF EXISTS "latitude",
        DROP COLUMN IF EXISTS "location"
    `);
    await queryRunner.query(`
      ALTER TABLE "jobs"
        DROP COLUMN IF EXISTS "landmark",
        DROP COLUMN IF EXISTS "location_accuracy_m"
    `);
    await queryRunner.query(`
      ALTER TABLE "jobs"
        ALTER COLUMN "latitude" TYPE numeric(10,2) USING "latitude"::numeric(10,2),
        ALTER COLUMN "longitude" TYPE numeric(10,2) USING "longitude"::numeric(10,2)
    `);
  }
}
