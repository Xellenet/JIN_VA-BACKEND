import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The service types customers pick from when they post a job, and artisans
 * add to their profile. Until now only the dev seed (`npm run seed`) created
 * them, and production runs migrations only, so its catalogue was empty and
 * the post-a-job dropdown had nothing in it.
 *
 * Data only: inserts these services and nothing else (no users, jobs or
 * prices).
 *
 * - Idempotent. A name that already exists, in any letter case, is skipped,
 *   so a database that already has "Plumbing" or "plumbing" keeps that row
 *   untouched, and running this again inserts nothing.
 *   `ON CONFLICT (name) DO NOTHING` also covers a row inserted between the
 *   check and the insert.
 * - `price` is left NULL. A catalogue price shows as the "typical starting
 *   price", which an admin sets from Admin > Services; the dev seed's prices
 *   were made up.
 * - `estimated_duration_mins` is NOT NULL with a default of 60, so it is left
 *   to that default.
 *
 * `down()` removes only rows that still look exactly as this migration
 * inserted them (same name, same description, no price) and that nothing
 * uses: no artisan offers it, no customer prefers it, and no job or booking
 * refers to it. A service an admin has priced or reworded, or that is in use,
 * stays.
 */
export const SERVICE_CATALOGUE: ReadonlyArray<{
  name: string;
  description: string;
}> = [
  {
    name: 'Plumbing',
    description: 'Water supply, drainage, and piping services',
  },
  {
    name: 'Electrical',
    description: 'Wiring, installations, and electrical repairs',
  },
  {
    name: 'Hair Braiding',
    description: 'Professional hair braiding and natural hair styling',
  },
  {
    name: 'Carpentry',
    description: 'Furniture making, repairs, and custom woodwork',
  },
  {
    name: 'Painting',
    description: 'Interior and exterior painting for homes and offices',
  },
  {
    name: 'Tiling',
    description: 'Floor and wall tiling installation and repairs',
  },
  {
    name: 'Cleaning',
    description: 'Professional residential and commercial cleaning services',
  },
  {
    name: 'Landscaping',
    description: 'Garden design, lawn care, and outdoor space maintenance',
  },
];

/** `($1, $2), ($3, $4), …` for the catalogue, with its flat parameter list. */
function catalogueValues(): { values: string; params: string[] } {
  const params: string[] = [];
  const values = SERVICE_CATALOGUE.map(({ name, description }) => {
    params.push(name, description);
    return `($${params.length - 1}, $${params.length})`;
  }).join(', ');
  return { values, params };
}

export class SeedServiceCatalogue1783350000000 implements MigrationInterface {
  name = 'SeedServiceCatalogue1783350000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const { values, params } = catalogueValues();
    await queryRunner.query(
      `
      INSERT INTO "services" ("name", "description")
      SELECT v."name", v."description"
        FROM (VALUES ${values}) AS v("name", "description")
       WHERE NOT EXISTS (
         SELECT 1 FROM "services" s WHERE LOWER(s."name") = LOWER(v."name")
       )
      ON CONFLICT ("name") DO NOTHING
      `,
      params,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const { values, params } = catalogueValues();
    await queryRunner.query(
      `
      DELETE FROM "services" s
       USING (VALUES ${values}) AS v("name", "description")
       WHERE s."name" = v."name"
         AND s."description" = v."description"
         AND s."price" IS NULL
         AND NOT EXISTS (SELECT 1 FROM "artisan_profile_services" x WHERE x."service_id" = s."id")
         AND NOT EXISTS (SELECT 1 FROM "customer_profile_services" x WHERE x."service_id" = s."id")
         AND NOT EXISTS (SELECT 1 FROM "jobs" x WHERE x."service_id" = s."id")
         AND NOT EXISTS (SELECT 1 FROM "bookings" x WHERE x."service_id" = s."id")
      `,
      params,
    );
  }
}
