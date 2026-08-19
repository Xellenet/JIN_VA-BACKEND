import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDirectMessages1782300000000 implements MigrationInterface {
  name = 'CreateDirectMessages1782300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "direct_messages" (
        "id"          SERIAL    NOT NULL,
        "sender_id"   integer   NOT NULL,
        "receiver_id" integer   NOT NULL,
        "content"     text      NOT NULL,
        "is_read"     boolean   NOT NULL DEFAULT false,
        "created_at"  TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_direct_messages" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`ALTER TABLE "direct_messages" ADD CONSTRAINT "FK_dm_sender" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE`);
    await queryRunner.query(`ALTER TABLE "direct_messages" ADD CONSTRAINT "FK_dm_receiver" FOREIGN KEY ("receiver_id") REFERENCES "users"("id") ON DELETE CASCADE`);
    await queryRunner.query(`CREATE INDEX "IDX_dm_sender" ON "direct_messages" ("sender_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_dm_receiver" ON "direct_messages" ("receiver_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_dm_sender_receiver" ON "direct_messages" ("sender_id", "receiver_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_dm_sender_receiver"`);
    await queryRunner.query(`DROP INDEX "IDX_dm_receiver"`);
    await queryRunner.query(`DROP INDEX "IDX_dm_sender"`);
    await queryRunner.query(`ALTER TABLE "direct_messages" DROP CONSTRAINT "FK_dm_receiver"`);
    await queryRunner.query(`ALTER TABLE "direct_messages" DROP CONSTRAINT "FK_dm_sender"`);
    await queryRunner.query(`DROP TABLE "direct_messages"`);
  }
}
