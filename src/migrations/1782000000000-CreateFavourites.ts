import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFavourites1782000000000 implements MigrationInterface {
  name = 'CreateFavourites1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "favourites" (
        "id" SERIAL NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "customer_id" integer NOT NULL,
        "artisan_profile_id" integer NOT NULL,
        CONSTRAINT "PK_favourites" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_favourites_customer_artisan" UNIQUE ("customer_id", "artisan_profile_id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "favourites"
      ADD CONSTRAINT "FK_favourites_customer_id"
      FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "favourites"
      ADD CONSTRAINT "FK_favourites_artisan_profile_id"
      FOREIGN KEY ("artisan_profile_id") REFERENCES "artisan_profiles"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "favourites" DROP CONSTRAINT "FK_favourites_artisan_profile_id"`);
    await queryRunner.query(`ALTER TABLE "favourites" DROP CONSTRAINT "FK_favourites_customer_id"`);
    await queryRunner.query(`DROP TABLE "favourites"`);
  }
}
