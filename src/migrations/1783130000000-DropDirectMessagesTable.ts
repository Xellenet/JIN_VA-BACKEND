import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MB1: drops the retired `direct_messages` table.
 *
 * Split from the backfill (`1783120000000-MigrateDirectMessagesToConversations`)
 * on purpose, even though `migration:run` executes both in one pass: keeping
 * them separate means an operator can run the backfill, verify the copied rows
 * in `conversations`/`messages`, and only then apply the drop — and can revert
 * *this* migration alone without undoing the backfill.
 *
 * Guarded by a safety check rather than an unconditional DROP. If for any
 * reason `direct_messages` still holds rows that are not present in `messages`,
 * this raises instead of dropping, so a bad or skipped backfill fails loudly at
 * deploy time rather than silently destroying message history. Re-running the
 * backfill migration resolves it.
 */
export class DropDirectMessagesTable1783130000000
  implements MigrationInterface
{
  name = 'DropDirectMessagesTable1783130000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        unmigrated BIGINT := 0;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'direct_messages'
        ) THEN
          RAISE NOTICE 'direct_messages already dropped — nothing to do.';
          RETURN;
        END IF;

        -- Every non-self-addressed source row must have a counterpart in the
        -- canonical tables before we let go of the original.
        SELECT COUNT(*) INTO unmigrated
          FROM direct_messages dm
         WHERE dm.sender_id <> dm.receiver_id
           AND NOT EXISTS (
                 SELECT 1
                   FROM messages m
                   JOIN conversations c ON c.id = m.conversation_id
                  WHERE c.participant_a_id = LEAST(dm.sender_id, dm.receiver_id)
                    AND c.participant_b_id = GREATEST(dm.sender_id, dm.receiver_id)
                    AND m.sender_id  = dm.sender_id
                    AND m.created_at = dm.created_at
                    AND m.content IS NOT DISTINCT FROM dm.content
               );

        IF unmigrated > 0 THEN
          RAISE EXCEPTION
            'Refusing to drop direct_messages: % row(s) have no counterpart in messages. Re-run MigrateDirectMessagesToConversations1783120000000 first.',
            unmigrated;
        END IF;

        DROP TABLE direct_messages;
        RAISE NOTICE 'direct_messages dropped — all rows verified present in messages.';
      END $$;
    `);
  }

  /**
   * Recreates the table's schema (empty). The original rows are not restored —
   * they live on in `conversations`/`messages`, which the backfill migration's
   * `down()` deliberately leaves in place.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "direct_messages" (
        "id"          SERIAL PRIMARY KEY,
        "sender_id"   INTEGER NOT NULL,
        "receiver_id" INTEGER NOT NULL,
        "content"     TEXT NOT NULL,
        "is_read"     BOOLEAN NOT NULL DEFAULT false,
        "created_at"  TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT "fk_direct_messages_sender"
          FOREIGN KEY ("sender_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_direct_messages_receiver"
          FOREIGN KEY ("receiver_id") REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_direct_messages_sender_id" ON "direct_messages" ("sender_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_direct_messages_receiver_id" ON "direct_messages" ("receiver_id")`,
    );
  }
}
