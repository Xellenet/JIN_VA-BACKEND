import { MigrationInterface, QueryRunner } from 'typeorm';

/** A1: artisan-declared date ranges during which they're unavailable. */
export class CreateBlockedSlots1782950000000 implements MigrationInterface {
  name = 'CreateBlockedSlots1782950000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "blocked_slots" (
        "id"                  SERIAL PRIMARY KEY,
        "artisan_profile_id"  INTEGER NOT NULL,
        "start_date"          DATE NOT NULL,
        "end_date"            DATE NOT NULL,
        "reason"              TEXT,
        "created_at"          TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT "fk_blocked_slots_artisan_profile"
          FOREIGN KEY ("artisan_profile_id") REFERENCES "artisan_profiles" ("id") ON DELETE CASCADE,
        CONSTRAINT "chk_blocked_slots_dates"
          CHECK ("end_date" >= "start_date")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_blocked_slots_artisan_profile_id"
        ON "blocked_slots" ("artisan_profile_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_blocked_slots_date_range"
        ON "blocked_slots" ("artisan_profile_id", "start_date", "end_date")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "blocked_slots"`);
  }
}
