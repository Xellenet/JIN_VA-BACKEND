import { MigrationInterface, QueryRunner } from 'typeorm';

/** J3: append-only audit trail of every job status transition. */
export class CreateJobStatusHistory1783000000000 implements MigrationInterface {
  name = 'CreateJobStatusHistory1783000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "job_status_history" (
        "id"          SERIAL PRIMARY KEY,
        "job_id"      INTEGER NOT NULL,
        "from_status" VARCHAR(20),
        "to_status"   VARCHAR(20) NOT NULL,
        "changed_by"  VARCHAR(20) NOT NULL,
        "reason"      TEXT,
        "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
        CONSTRAINT "fk_job_status_history_job"
          FOREIGN KEY ("job_id") REFERENCES "jobs" ("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_job_status_history_job_id_created_at"
        ON "job_status_history" ("job_id", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "job_status_history"`);
  }
}
