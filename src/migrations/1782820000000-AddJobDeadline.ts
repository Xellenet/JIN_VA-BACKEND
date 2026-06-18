import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobDeadline1782820000000 implements MigrationInterface {
  name = 'AddJobDeadline1782820000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "jobs"
      ADD COLUMN IF NOT EXISTS "deadline" TIMESTAMPTZ
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_jobs_status_deadline"
        ON "jobs" ("status", "deadline")
        WHERE "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_jobs_status_deadline"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN IF EXISTS "deadline"`);
  }
}
