import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReviewJobEnforcement1781800000000 implements MigrationInterface {
  name = 'AddReviewJobEnforcement1781800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reviews" ADD COLUMN "job_id" integer`,
    );

    await queryRunner.query(
      `ALTER TABLE "reviews" ADD CONSTRAINT "FK_reviews_job_id" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE`,
    );

    // Partial unique index: one review per job (NULLs not included, preserving any legacy rows)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_reviews_job_id" ON "reviews" ("job_id") WHERE "job_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."UQ_reviews_job_id"`);
    await queryRunner.query(
      `ALTER TABLE "reviews" DROP CONSTRAINT "FK_reviews_job_id"`,
    );
    await queryRunner.query(`ALTER TABLE "reviews" DROP COLUMN "job_id"`);
  }
}
