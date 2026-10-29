import { MigrationInterface, QueryRunner } from 'typeorm';

/** J4: photo attachments on a job, uploaded via the existing storage abstraction. */
export class CreateJobAttachments1783010000000 implements MigrationInterface {
  name = 'CreateJobAttachments1783010000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "job_attachments" (
        "id"         SERIAL PRIMARY KEY,
        "job_id"     INTEGER NOT NULL,
        "url"        VARCHAR NOT NULL,
        "file_type"  VARCHAR(100) NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT "fk_job_attachments_job"
          FOREIGN KEY ("job_id") REFERENCES "jobs" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_job_attachments_job_id"
        ON "job_attachments" ("job_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "job_attachments"`);
  }
}
