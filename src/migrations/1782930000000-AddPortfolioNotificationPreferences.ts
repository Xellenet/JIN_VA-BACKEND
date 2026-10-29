import { MigrationInterface, QueryRunner } from 'typeorm';

/** PF5: notification preference toggles for the new PORTFOLIO_APPROVED / PORTFOLIO_REJECTED events. */
export class AddPortfolioNotificationPreferences1782930000000
  implements MigrationInterface
{
  name = 'AddPortfolioNotificationPreferences1782930000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "portfolio_approved" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "portfolio_rejected" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "portfolio_rejected"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "portfolio_approved"`,
    );
  }
}
