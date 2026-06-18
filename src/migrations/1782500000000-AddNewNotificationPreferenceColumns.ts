import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNewNotificationPreferenceColumns1782500000000 implements MigrationInterface {
  name = 'AddNewNotificationPreferenceColumns1782500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "job_expired"            boolean NOT NULL DEFAULT true`);
    await queryRunner.query(`ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "application_rejected"   boolean NOT NULL DEFAULT true`);
    await queryRunner.query(`ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "applied_job_expired"    boolean NOT NULL DEFAULT true`);
    await queryRunner.query(`ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "profile_verified"       boolean NOT NULL DEFAULT true`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "profile_verified"`);
    await queryRunner.query(`ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "applied_job_expired"`);
    await queryRunner.query(`ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "application_rejected"`);
    await queryRunner.query(`ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "job_expired"`);
  }
}
