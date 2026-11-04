import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reply to a specific message (WhatsApp-style quoting).
 *
 * - `reply_to_message_id`: the message being replied to. FK to `messages`
 *   with ON DELETE SET NULL, so removing the original never removes a reply.
 * - `is_reply`: whether the message was sent as a reply. Needed because the
 *   SET NULL above erases the pointer when the original goes: without this
 *   flag a reply to a since-deleted message would be indistinguishable from
 *   an ordinary message, and the client could not say "Original message
 *   deleted".
 *
 * Idempotent (IF NOT EXISTS / a guarded constraint), because the dev servers
 * run migrations on start and an interrupted run must be safe to repeat.
 */
export class AddMessageReplyTo1783420000000 implements MigrationInterface {
  name = 'AddMessageReplyTo1783420000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "messages"
        ADD COLUMN IF NOT EXISTS "reply_to_message_id" integer NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "messages"
        ADD COLUMN IF NOT EXISTS "is_reply" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_messages_reply_to_message'
        ) THEN
          ALTER TABLE "messages"
            ADD CONSTRAINT "FK_messages_reply_to_message"
            FOREIGN KEY ("reply_to_message_id") REFERENCES "messages"("id")
            ON DELETE SET NULL;
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_messages_reply_to_message_id"
        ON "messages" ("reply_to_message_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_messages_reply_to_message_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "FK_messages_reply_to_message"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP COLUMN IF EXISTS "is_reply"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP COLUMN IF EXISTS "reply_to_message_id"`,
    );
  }
}
