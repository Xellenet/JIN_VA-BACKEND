import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMessages1782100000000 implements MigrationInterface {
  name = 'CreateMessages1782100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "conversations" (
        "id"              SERIAL    NOT NULL,
        "participant_a_id" integer  NOT NULL,
        "participant_b_id" integer  NOT NULL,
        "last_message_at" TIMESTAMP,
        "created_at"      TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_conversations" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_conversations_participants" UNIQUE ("participant_a_id", "participant_b_id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "conversations"
      ADD CONSTRAINT "FK_conversations_participant_a"
      FOREIGN KEY ("participant_a_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "conversations"
      ADD CONSTRAINT "FK_conversations_participant_b"
      FOREIGN KEY ("participant_b_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_conversations_participant_a" ON "conversations" ("participant_a_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_conversations_participant_b" ON "conversations" ("participant_b_id")
    `);

    await queryRunner.query(`
      CREATE TABLE "messages" (
        "id"              SERIAL   NOT NULL,
        "conversation_id" integer  NOT NULL,
        "sender_id"       integer  NOT NULL,
        "content"         text     NOT NULL,
        "is_read"         boolean  NOT NULL DEFAULT false,
        "created_at"      TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_messages" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "messages"
      ADD CONSTRAINT "FK_messages_conversation_id"
      FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "messages"
      ADD CONSTRAINT "FK_messages_sender_id"
      FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_messages_conversation_id" ON "messages" ("conversation_id")
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_messages_sender_id" ON "messages" ("sender_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_messages_sender_id"`);
    await queryRunner.query(`DROP INDEX "IDX_messages_conversation_id"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP CONSTRAINT "FK_messages_sender_id"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP CONSTRAINT "FK_messages_conversation_id"`);
    await queryRunner.query(`DROP TABLE "messages"`);

    await queryRunner.query(`DROP INDEX "IDX_conversations_participant_b"`);
    await queryRunner.query(`DROP INDEX "IDX_conversations_participant_a"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP CONSTRAINT "FK_conversations_participant_b"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP CONSTRAINT "FK_conversations_participant_a"`);
    await queryRunner.query(`DROP TABLE "conversations"`);
  }
}
