import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDeviceTokens1782860000000 implements MigrationInterface {
  name = 'CreateDeviceTokens1782860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."device_tokens_platform_enum" AS ENUM ('ios', 'android', 'web')
    `);

    await queryRunner.query(`
      CREATE TABLE "device_tokens" (
        "id"         SERIAL                                      NOT NULL,
        "user_id"    INTEGER                                     NOT NULL,
        "token"      CHARACTER VARYING                           NOT NULL,
        "platform"   "public"."device_tokens_platform_enum"     NOT NULL DEFAULT 'android',
        "created_at" TIMESTAMP WITH TIME ZONE                   NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMP WITH TIME ZONE                   NOT NULL DEFAULT NOW(),
        CONSTRAINT "uq_device_tokens_token"   UNIQUE ("token"),
        CONSTRAINT "pk_device_tokens"         PRIMARY KEY ("id"),
        CONSTRAINT "fk_device_tokens_user_id" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "idx_device_tokens_user_id" ON "device_tokens" ("user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_device_tokens_user_id"`);
    await queryRunner.query(`DROP TABLE "device_tokens"`);
    await queryRunner.query(`DROP TYPE "public"."device_tokens_platform_enum"`);
  }
}
