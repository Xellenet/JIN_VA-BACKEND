import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MB1 data continuity: backfills every row from the retired `direct_messages`
 * table into the canonical `conversations`/`messages` tables.
 *
 * requirements.md's edge-cases section flags this explicitly: "if any real
 * conversation data exists in `/direct-messages`' table in any deployed
 * environment, it must not be silently dropped when the frontend cuts over".
 *
 * This is written as an unconditional, idempotent backfill rather than a
 * "check the dev database first, then decide" one-off, deliberately:
 *
 *  - It is correct whether the table holds zero rows or a million. On an empty
 *    table every statement below is a no-op.
 *  - It is correct in environments nobody inspected. Whatever the dev database
 *    happens to contain says nothing about staging or production, and the
 *    frontend cutover applies to all of them.
 *  - It is safe to re-run. Each insert is guarded by a NOT EXISTS check, so a
 *    replay (or a partial failure followed by a retry) cannot duplicate a
 *    conversation or a message.
 *
 * Mapping notes:
 *
 *  - `direct_messages` was a flat (sender, receiver) log with no conversation
 *    entity. Pairs are collapsed with LEAST/GREATEST to match the canonical
 *    model's stable "lower participant id is always participantA" ordering, so
 *    a back-and-forth exchange lands in one thread rather than two.
 *  - `conversations.created_at` is seeded from the pair's *earliest* message
 *    and `last_message_at` from its latest, so the migrated threads sort into
 *    the conversation list in the right place instead of all appearing new.
 *  - Self-messages (`sender_id = receiver_id`) are skipped. They were only
 *    possible because the retired module had no validation at all; the
 *    canonical model rejects them, and a conversation with itself has no
 *    meaningful representation. The count is reported via RAISE NOTICE.
 *  - Same-role pairs (customer↔customer, or anything involving an admin) *are*
 *    migrated, because dropping real message history would be worse than
 *    keeping it. Note the consequence: MB2's role check means no *new* message
 *    can be added to such a thread, so any that exist become effectively
 *    read-only history. Reading them is unaffected — thread access is
 *    participation-based, not role-based.
 *  - Attachments and job/booking context are left null: the retired table had
 *    no such columns, so there is nothing to carry over.
 *
 * Dedup key is (conversation, sender, created_at, content). Two distinct
 * messages colliding on all four would require the same user sending identical
 * text at the identical timestamp, which the source table's own
 * `CreateDateColumn` resolution makes a non-case.
 */
export class MigrateDirectMessagesToConversations1783120000000
  implements MigrationInterface
{
  name = 'MigrateDirectMessagesToConversations1783120000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        source_rows    BIGINT := 0;
        self_rows      BIGINT := 0;
        new_convos     BIGINT := 0;
        new_messages   BIGINT := 0;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'direct_messages'
        ) THEN
          RAISE NOTICE 'direct_messages table not present — nothing to migrate.';
          RETURN;
        END IF;

        SELECT COUNT(*) INTO source_rows FROM direct_messages;
        SELECT COUNT(*) INTO self_rows
          FROM direct_messages WHERE sender_id = receiver_id;

        IF source_rows = 0 THEN
          RAISE NOTICE 'direct_messages is empty — nothing to migrate.';
          RETURN;
        END IF;

        -- 1. One conversation per distinct participant pair, in the canonical
        --    lower-id-first ordering. NOT EXISTS rather than ON CONFLICT so
        --    this does not depend on the unique constraint's generated name.
        WITH pairs AS (
          SELECT LEAST(sender_id, receiver_id)    AS a,
                 GREATEST(sender_id, receiver_id) AS b,
                 MIN(created_at)                  AS first_at,
                 MAX(created_at)                  AS last_at
            FROM direct_messages
           WHERE sender_id <> receiver_id
           GROUP BY 1, 2
        )
        INSERT INTO conversations (participant_a_id, participant_b_id, last_message_at, created_at)
        SELECT p.a, p.b, p.last_at, p.first_at
          FROM pairs p
         WHERE NOT EXISTS (
                 SELECT 1 FROM conversations c
                  WHERE c.participant_a_id = p.a
                    AND c.participant_b_id = p.b
               );
        GET DIAGNOSTICS new_convos = ROW_COUNT;

        -- 2. Every source message, attached to its pair's conversation.
        INSERT INTO messages (conversation_id, sender_id, content, is_read, created_at)
        SELECT c.id, dm.sender_id, dm.content, dm.is_read, dm.created_at
          FROM direct_messages dm
          JOIN conversations c
            ON c.participant_a_id = LEAST(dm.sender_id, dm.receiver_id)
           AND c.participant_b_id = GREATEST(dm.sender_id, dm.receiver_id)
         WHERE dm.sender_id <> dm.receiver_id
           AND NOT EXISTS (
                 SELECT 1 FROM messages m
                  WHERE m.conversation_id = c.id
                    AND m.sender_id       = dm.sender_id
                    AND m.created_at      = dm.created_at
                    AND m.content IS NOT DISTINCT FROM dm.content
               );
        GET DIAGNOSTICS new_messages = ROW_COUNT;

        -- 3. Keep last_message_at truthful for any conversation that gained
        --    newer history than it already had (e.g. a pair that had messaged
        --    through both modules).
        UPDATE conversations c
           SET last_message_at = agg.max_at
          FROM (
                 SELECT conversation_id, MAX(created_at) AS max_at
                   FROM messages
                  GROUP BY conversation_id
               ) agg
         WHERE agg.conversation_id = c.id
           AND (c.last_message_at IS NULL OR c.last_message_at < agg.max_at);

        RAISE NOTICE 'direct_messages backfill: % source row(s) (% self-addressed, skipped) -> % new conversation(s), % new message(s).',
          source_rows, self_rows, new_convos, new_messages;
      END $$;
    `);
  }

  /**
   * Deliberately a no-op.
   *
   * Reverting this would mean deciding which `messages` rows originated in
   * `direct_messages` and splitting merged threads back apart — and the
   * backfill intentionally merges history that may also have arrived through
   * the canonical module, so that split is not recoverable from the data
   * alone. Deleting rows on a guess would destroy real messages.
   *
   * A revert is harmless without this: the copied rows are valid canonical
   * data, and the following migration's `down()` recreates `direct_messages`
   * (empty), so the schema returns to its previous shape. Only the retired
   * table's *contents* are not restored — and those same contents are still
   * present, readable, in `messages`.
   */
  public async down(): Promise<void> {
    // Intentionally empty — see the doc comment above.
  }
}
