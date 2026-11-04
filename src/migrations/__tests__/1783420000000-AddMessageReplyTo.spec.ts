import { PGlite } from '@electric-sql/pglite';
import type { QueryRunner } from 'typeorm';
import { AddMessageReplyTo1783420000000 } from '../1783420000000-AddMessageReplyTo';

/** Against real Postgres (PGlite, in-process), with fictional rows. */
describe('AddMessageReplyTo migration', () => {
  let db: PGlite;
  const runner = {
    query: async (sql: string, params: unknown[] = []) =>
      (await db.query(sql, params)).rows,
  } as unknown as QueryRunner;
  const migration = new AddMessageReplyTo1783420000000();

  // One in-process Postgres per file (starting one is the slow part, more so
  // under coverage); each test gets a fresh table.
  beforeAll(async () => {
    db = await PGlite.create();
  }, 60000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec(`
      DROP TABLE IF EXISTS "messages";
      CREATE TABLE "messages" ("id" SERIAL PRIMARY KEY, "content" text NULL);
      INSERT INTO "messages" ("content") VALUES ('Is Thursday fine?'), ('Yes');
    `);
  });

  it('adds the columns, leaves existing rows as non-replies, and can run twice', async () => {
    await migration.up(runner);
    await migration.up(runner);

    const rows = await db.query<{
      reply_to_message_id: number | null;
      is_reply: boolean;
    }>('SELECT "reply_to_message_id", "is_reply" FROM "messages" ORDER BY id');
    expect(rows.rows).toEqual([
      { reply_to_message_id: null, is_reply: false },
      { reply_to_message_id: null, is_reply: false },
    ]);
    const index = await db.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'IDX_messages_reply_to_message_id'`,
    );
    expect(index.rows).toHaveLength(1);
  });

  it('nulls the pointer, but keeps is_reply, when the original is deleted', async () => {
    await migration.up(runner);
    await db.query(
      `UPDATE "messages" SET "reply_to_message_id" = 1, "is_reply" = true WHERE id = 2`,
    );
    await db.query('DELETE FROM "messages" WHERE id = 1');

    const row = await db.query<{
      reply_to_message_id: number | null;
      is_reply: boolean;
    }>('SELECT "reply_to_message_id", "is_reply" FROM "messages" WHERE id = 2');
    expect(row.rows[0]).toEqual({ reply_to_message_id: null, is_reply: true });
  });

  it('rejects a pointer to a message that does not exist', async () => {
    await migration.up(runner);
    await expect(
      db.query(
        `UPDATE "messages" SET "reply_to_message_id" = 999 WHERE id = 2`,
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('down() removes everything and is safe to repeat', async () => {
    await migration.up(runner);
    await migration.down(runner);
    await migration.down(runner);
    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'messages' AND column_name IN ('reply_to_message_id', 'is_reply')`,
    );
    expect(cols.rows).toHaveLength(0);
  });
});
