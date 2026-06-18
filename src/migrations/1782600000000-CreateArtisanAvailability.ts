import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateArtisanAvailability1782600000000 implements MigrationInterface {
  name = 'CreateArtisanAvailability1782600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "artisan_availability" (
        "id"                  SERIAL    NOT NULL,
        "artisan_profile_id"  integer   NOT NULL,
        "day_of_week"         smallint  NOT NULL,
        "start_time"          time      NOT NULL,
        "end_time"            time      NOT NULL,
        "is_active"           boolean   NOT NULL DEFAULT true,
        "created_at"          TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"          TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_artisan_availability"  PRIMARY KEY ("id"),
        CONSTRAINT "CHK_aa_day_range"         CHECK ("day_of_week" BETWEEN 0 AND 6),
        CONSTRAINT "CHK_aa_time_order"        CHECK ("end_time" > "start_time")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "artisan_availability"
      ADD CONSTRAINT "FK_aa_artisan_profile"
      FOREIGN KEY ("artisan_profile_id")
      REFERENCES "artisan_profiles"("id") ON DELETE CASCADE
    `);

    // Prevent exact duplicate slots (same artisan, day, start time)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_aa_profile_day_start"
      ON "artisan_availability" ("artisan_profile_id", "day_of_week", "start_time")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_aa_profile"
      ON "artisan_availability" ("artisan_profile_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_aa_profile"`);
    await queryRunner.query(`DROP INDEX "UQ_aa_profile_day_start"`);
    await queryRunner.query(`ALTER TABLE "artisan_availability" DROP CONSTRAINT "FK_aa_artisan_profile"`);
    await queryRunner.query(`DROP TABLE "artisan_availability"`);
  }
}
