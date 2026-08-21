import { MigrationInterface, QueryRunner } from 'typeorm';

/** RP1: photo attachments on a review, uploaded via the existing storage abstraction. */
export class CreateReviewPhotos1783060000000 implements MigrationInterface {
  name = 'CreateReviewPhotos1783060000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "review_photos" (
        "id"         SERIAL PRIMARY KEY,
        "review_id"  INTEGER NOT NULL,
        "url"        VARCHAR NOT NULL,
        "file_type"  VARCHAR(100) NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT "fk_review_photos_review"
          FOREIGN KEY ("review_id") REFERENCES "reviews" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_review_photos_review_id"
        ON "review_photos" ("review_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "review_photos"`);
  }
}
