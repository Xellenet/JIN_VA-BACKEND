import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVerificationRejectedNotificationColumn1782810000000 implements MigrationInterface {
  name = 'AddVerificationRejectedNotificationColumn1782810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_preferences"
      ADD COLUMN IF NOT EXISTS "verification_rejected" BOOLEAN NOT NULL DEFAULT true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "notification_preferences"
      DROP COLUMN IF EXISTS "verification_rejected"
    `);
  }
}
