import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddArtisanPayoutFields1782890000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "artisan_profiles"
        ADD COLUMN IF NOT EXISTS "payout_type"              VARCHAR(20),
        ADD COLUMN IF NOT EXISTS "paystack_recipient_code"  VARCHAR(100),
        ADD COLUMN IF NOT EXISTS "payout_account_name"      VARCHAR(200),
        ADD COLUMN IF NOT EXISTS "payout_account_number"    VARCHAR(50),
        ADD COLUMN IF NOT EXISTS "payout_bank_code"         VARCHAR(20)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "artisan_profiles"
        DROP COLUMN IF EXISTS "payout_type",
        DROP COLUMN IF EXISTS "paystack_recipient_code",
        DROP COLUMN IF EXISTS "payout_account_name",
        DROP COLUMN IF EXISTS "payout_account_number",
        DROP COLUMN IF EXISTS "payout_bank_code"
    `);
  }
}
