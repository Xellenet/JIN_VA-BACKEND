import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJobApplicationsAndTransitions1781700000000 implements MigrationInterface {
  name = 'AddJobApplicationsAndTransitions1781700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // New columns on the jobs table to support the full lifecycle.
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "accepted_artisan_id" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "payment_intent_id" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "completion_requested_at" TIMESTAMP`,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD CONSTRAINT "FK_jobs_accepted_artisan" FOREIGN KEY ("accepted_artisan_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    // Enum type for application status.
    await queryRunner.query(
      `CREATE TYPE "public"."job_applications_status_enum" AS ENUM('PENDING', 'ACCEPTED', 'REJECTED')`,
    );

    // job_applications table.
    await queryRunner.query(`
      CREATE TABLE "job_applications" (
        "id"          SERIAL NOT NULL,
        "job_id"      integer NOT NULL,
        "artisan_id"  integer NOT NULL,
        "quote_price" numeric(10,2),
        "message"     text,
        "status"      "public"."job_applications_status_enum" NOT NULL DEFAULT 'PENDING',
        "created_at"  TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at"  TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_job_applications" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_job_applications_artisan_job" UNIQUE ("job_id", "artisan_id")
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "job_applications" ADD CONSTRAINT "FK_job_applications_job" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_applications" ADD CONSTRAINT "FK_job_applications_artisan" FOREIGN KEY ("artisan_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "job_applications" DROP CONSTRAINT "FK_job_applications_artisan"`);
    await queryRunner.query(`ALTER TABLE "job_applications" DROP CONSTRAINT "FK_job_applications_job"`);
    await queryRunner.query(`DROP TABLE "job_applications"`);
    await queryRunner.query(`DROP TYPE "public"."job_applications_status_enum"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP CONSTRAINT "FK_jobs_accepted_artisan"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "completion_requested_at"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "payment_intent_id"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "accepted_artisan_id"`);
  }
}
