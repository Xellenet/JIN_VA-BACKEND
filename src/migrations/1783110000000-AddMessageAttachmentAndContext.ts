import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MC2 + MC4 on the canonical `messages` table.
 *
 * MC4 — image attachments:
 *  - `attachment_url` / `attachment_type` hold the single attached image.
 *    Stored inline rather than in a child table because the design spec scopes
 *    messages to exactly one attachment (unlike `review_photos`, which needed
 *    up to three per review). Sending several images means several messages.
 *  - `content` drops its NOT NULL, since a message may be image-only. The
 *    1–2000 character bound (MC3) is unchanged and still enforced at the DTO
 *    layer; `MessagesService.send` rejects a message with neither text nor an
 *    attachment, so a row with both columns null cannot be created through the
 *    API.
 *
 * MC2 — job/booking context:
 *  - `job_id` / `booking_id` record what a message was composed *about*. This
 *    is metadata on the existing persistent one-thread-per-user-pair model —
 *    it does not scope the thread to a job, does not create a thread per job,
 *    and does not archive anything. Both are nullable: a general inquiry from
 *    an artisan's profile or the favourites list carries neither.
 *  - `ON DELETE SET NULL` on both, so deleting a job/booking never cascades
 *    into deleting message history — the conversation outlives the job that
 *    prompted it.
 *
 * Also adds the two indexes the consolidated conversation-list query needs:
 * the per-conversation newest-message lookup and the unread-count aggregate.
 */
export class AddMessageAttachmentAndContext1783110000000
  implements MigrationInterface
{
  name = 'AddMessageAttachmentAndContext1783110000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "messages"
        ADD COLUMN IF NOT EXISTS "attachment_url"  VARCHAR,
        ADD COLUMN IF NOT EXISTS "attachment_type" VARCHAR(100),
        ADD COLUMN IF NOT EXISTS "job_id"          INTEGER,
        ADD COLUMN IF NOT EXISTS "booking_id"      INTEGER
    `);

    // MC4: image-only messages have no text.
    await queryRunner.query(
      `ALTER TABLE "messages" ALTER COLUMN "content" DROP NOT NULL`,
    );

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_messages_job'
        ) THEN
          ALTER TABLE "messages"
            ADD CONSTRAINT "fk_messages_job"
            FOREIGN KEY ("job_id") REFERENCES "jobs" ("id") ON DELETE SET NULL;
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_messages_booking'
        ) THEN
          ALTER TABLE "messages"
            ADD CONSTRAINT "fk_messages_booking"
            FOREIGN KEY ("booking_id") REFERENCES "bookings" ("id") ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // MB3: backs the DISTINCT ON (conversation_id) ... ORDER BY created_at DESC
    // last-message lookup and the thread's chronological read.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messages_conversation_created_at"
        ON "messages" ("conversation_id", "created_at" DESC)
    `);

    // MB3/MR1: backs the per-conversation unread aggregate, which filters on
    // sender and read state together.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messages_conversation_sender_unread"
        ON "messages" ("conversation_id", "sender_id")
        WHERE "is_read" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."idx_messages_conversation_sender_unread"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."idx_messages_conversation_created_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "fk_messages_booking"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "fk_messages_job"`,
    );

    // Any image-only message would violate the restored NOT NULL, so give it
    // placeholder text rather than failing the revert or silently deleting it.
    await queryRunner.query(
      `UPDATE "messages" SET "content" = '[image]' WHERE "content" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ALTER COLUMN "content" SET NOT NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE "messages"
        DROP COLUMN IF EXISTS "booking_id",
        DROP COLUMN IF EXISTS "job_id",
        DROP COLUMN IF EXISTS "attachment_type",
        DROP COLUMN IF EXISTS "attachment_url"
    `);
  }
}
