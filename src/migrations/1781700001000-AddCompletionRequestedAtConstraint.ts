import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCompletionRequestedAtConstraint1781700001000 implements MigrationInterface {
  name = 'AddCompletionRequestedAtConstraint1781700001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "jobs"
      ADD CONSTRAINT "CHK_jobs_completion_requested_at"
      CHECK (
        "completion_requested_at" IS NULL
        OR "completion_requested_at" >= "created_at"
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jobs" DROP CONSTRAINT "CHK_jobs_completion_requested_at"`,
    );
  }
}
