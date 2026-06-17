import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddArtisanProfileSearchFields1781900000000 implements MigrationInterface {
  name = 'AddArtisanProfileSearchFields1781900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "artisan_profiles" ADD COLUMN "is_verified" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "artisan_profiles" ADD COLUMN "location" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "artisan_profiles" DROP COLUMN "location"`,
    );
    await queryRunner.query(
      `ALTER TABLE "artisan_profiles" DROP COLUMN "is_verified"`,
    );
  }
}
