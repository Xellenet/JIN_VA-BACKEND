import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateArtisanVerifications1782800000000 implements MigrationInterface {
  name = 'CreateArtisanVerifications1782800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "artisan_verifications" (
        "id"                    SERIAL PRIMARY KEY,
        "artisan_profile_id"    INTEGER NOT NULL,
        "document_type"         VARCHAR(50) NOT NULL,
        "id_number"             VARCHAR(100),
        "full_legal_name"       VARCHAR(200),
        "date_of_birth"         DATE,
        "document_front_url"    TEXT NOT NULL,
        "document_back_url"     TEXT,
        "selfie_url"            TEXT NOT NULL,
        "additional_notes"      TEXT,
        "status"                VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        "provider"              VARCHAR(50) NOT NULL DEFAULT 'manual',
        "provider_reference"    VARCHAR(200),
        "provider_raw_response" JSONB,
        "admin_notes"           TEXT,
        "rejection_reason"      TEXT,
        "reviewed_by_id"        INTEGER,
        "reviewed_at"           TIMESTAMPTZ,
        "created_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "fk_artisan_verifications_profile"
          FOREIGN KEY ("artisan_profile_id")
          REFERENCES "artisan_profiles" ("id")
          ON DELETE CASCADE,
        CONSTRAINT "fk_artisan_verifications_reviewer"
          FOREIGN KEY ("reviewed_by_id")
          REFERENCES "users" ("id")
          ON DELETE SET NULL,
        CONSTRAINT "chk_artisan_verifications_status"
          CHECK ("status" IN ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_artisan_verifications_profile_id"
        ON "artisan_verifications" ("artisan_profile_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_artisan_verifications_status"
        ON "artisan_verifications" ("status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "artisan_verifications"`);
  }
}
