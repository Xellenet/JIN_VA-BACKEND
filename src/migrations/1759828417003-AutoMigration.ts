import { MigrationInterface, QueryRunner } from "typeorm";

export class AutoMigration1759828417003 implements MigrationInterface {
    name = 'AutoMigration1759828417003'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "verifiedAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "users" ADD "accountVerified" boolean`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "accountVerified"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "verifiedAt"`);
    }

}
