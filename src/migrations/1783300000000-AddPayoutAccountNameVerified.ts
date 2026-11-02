import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payout account lookup: whether the stored payout account name came from
 * Paystack's account name lookup (true) or was typed while the lookup was
 * unavailable (false). Null for methods saved before this existed.
 */
export class AddPayoutAccountNameVerified1783300000000
  implements MigrationInterface
{
  name = 'AddPayoutAccountNameVerified1783300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "artisan_profiles"
        ADD COLUMN IF NOT EXISTS "payout_account_name_verified" BOOLEAN NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "artisan_profiles"
        DROP COLUMN IF EXISTS "payout_account_name_verified"
    `);
  }
}
