import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCurrencyFields1782700000000 implements MigrationInterface {
  name = 'AddCurrencyFields1782700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // jobs: currency code for budgetMin / budgetMax
    await queryRunner.query(`
      ALTER TABLE "jobs"
      ADD COLUMN IF NOT EXISTS "currency" VARCHAR(3) NOT NULL DEFAULT 'GHS'
    `);

    // artisan_profiles: currency code for hourlyRate
    await queryRunner.query(`
      ALTER TABLE "artisan_profiles"
      ADD COLUMN IF NOT EXISTS "currency" VARCHAR(3) NOT NULL DEFAULT 'GHS'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "artisan_profiles" DROP COLUMN IF EXISTS "currency"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN IF EXISTS "currency"`);
  }
}
