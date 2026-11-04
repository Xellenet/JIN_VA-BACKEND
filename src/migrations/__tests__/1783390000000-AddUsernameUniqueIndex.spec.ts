import { PGlite } from '@electric-sql/pglite';
import type { QueryRunner } from 'typeorm';
import { AddUsernameUniqueIndex1783390000000 } from '../1783390000000-AddUsernameUniqueIndex';
import { dedupeUsernamesAndCreateIndex } from '../../database/migration-helpers/username-dedupe';
import { EnsureUsernameUniqueIndex1783400000000 } from '../1783400000000-EnsureUsernameUniqueIndex';

/** Against real Postgres (PGlite, in-process), with fictional rows. */
describe('username unique index migration', () => {
  let db: PGlite;
  const runner = {
    query: async (sql: string, params: unknown[] = []) =>
      (await db.query(sql, params)).rows,
  } as unknown as QueryRunner;
  const names = async () =>
    (
      await db.query<{ id: number; username: string | null }>(
        'SELECT "id", "username" FROM "users" ORDER BY "id"',
      )
    ).rows.map((r) => r.username);

  beforeEach(async () => {
    db = await PGlite.create();
    await db.exec(`
      CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "username" varchar NULL, "deleted_at" timestamp NULL);
      INSERT INTO "users" ("username", "deleted_at") VALUES
        ('ama.mensah', NULL),   -- 1 keeps
        ('Ama.Mensah', NULL),   -- 2 → Ama.Mensah3 (ama.mensah2 is taken)
        ('ama.mensah2', NULL),  -- 3 keeps
        ('kofi', now()),        -- 4 keeps (soft-deleted still counts)
        ('KOFI', NULL),         -- 5 → KOFI2
        ('kofi', NULL),         -- 6 → kofi3
        (NULL, NULL),           -- 7 purged, ignored
        (NULL, NULL),           -- 8 purged, ignored
        ('esi', NULL);          -- 9 keeps
    `);
    // PGlite boots a whole Postgres in-process: under coverage that can take
    // longer than Jest's default 5 s hook limit.
  }, 60000);
  afterEach(async () => {
    await db.close();
  }, 60000);

  it('renames later duplicates deterministically, then builds the case-insensitive index', async () => {
    await new AddUsernameUniqueIndex1783390000000().up(runner);
    expect(await names()).toEqual([
      'ama.mensah',
      'Ama.Mensah3',
      'ama.mensah2',
      'kofi',
      'KOFI2',
      'kofi3',
      null,
      null,
      'esi',
    ]);
    await expect(
      db.query(`INSERT INTO "users" ("username") VALUES ('ESI')`),
    ).rejects.toThrow(/duplicate key/);
    await db.query(`INSERT INTO "users" ("username") VALUES (NULL)`);
  });

  it('is idempotent, and the follow-up migration changes nothing', async () => {
    expect(await dedupeUsernamesAndCreateIndex(runner)).toBe(3);
    const after = await names();
    expect(await dedupeUsernamesAndCreateIndex(runner)).toBe(0);
    await new EnsureUsernameUniqueIndex1783400000000().up(runner);
    await new EnsureUsernameUniqueIndex1783400000000().down();
    expect(await names()).toEqual(after);
  });

  it('down drops the index', async () => {
    const m = new AddUsernameUniqueIndex1783390000000();
    await m.up(runner);
    await m.down(runner);
    await db.query(`INSERT INTO "users" ("username") VALUES ('ESI')`);
  });
});
