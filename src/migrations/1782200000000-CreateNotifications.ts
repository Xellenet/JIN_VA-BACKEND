import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateNotifications1782200000000 implements MigrationInterface {
  name = 'CreateNotifications1782200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id"         SERIAL    NOT NULL,
        "user_id"    integer   NOT NULL,
        "type"       varchar   NOT NULL,
        "title"      varchar   NOT NULL,
        "body"       text      NOT NULL,
        "is_read"    boolean   NOT NULL DEFAULT false,
        "payload"    jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notifications" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "notifications"
      ADD CONSTRAINT "FK_notifications_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_notifications_user_id" ON "notifications" ("user_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_notifications_user_is_read" ON "notifications" ("user_id", "is_read")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_notifications_user_is_read"`);
    await queryRunner.query(`DROP INDEX "IDX_notifications_user_id"`);
    await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT "FK_notifications_user_id"`);
    await queryRunner.query(`DROP TABLE "notifications"`);
  }
}
