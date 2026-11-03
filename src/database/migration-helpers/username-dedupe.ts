import { Logger } from '@nestjs/common';
import type { QueryRunner } from 'typeorm';

/**
 * Makes `users.username` unique, case-insensitively, so the sign-up
 * generator (`first.last`, `first.last2`…) can rely on the database to
 * settle a race, and `PATCH /users/me` can't create a clash.
 *
 * Nothing enforced uniqueness before, so existing rows may collide (`Kofi`
 * and `kofi`, or two `ama.mensah`). Before the index is built, every
 * collision is resolved deterministically: within each group of usernames
 * equal ignoring case, the row with the lowest id keeps its username and each
 * later row (by id) gets the smallest number ≥ 2 appended that is free
 * (`ama.mensah` → `ama.mensah2`). Soft-deleted rows count, because they can
 * still be restored with their username; purged rows have NULL, which the
 * partial index ignores. How many rows were renamed is logged.
 *
 * Idempotent: with no collisions nothing is renamed and the index is created
 * only if missing. Shared by `AddUsernameUniqueIndex1783390000000` and
 * `EnsureUsernameUniqueIndex1783400000000`, which runs the same step on a database that ran an earlier draft of this
 * migration.
 */
export async function dedupeUsernamesAndCreateIndex(
  queryRunner: QueryRunner,
): Promise<number> {
  const rows = (await queryRunner.query(
    `SELECT "id", "username" FROM "users"
      WHERE "username" IS NOT NULL
        AND LOWER("username") IN (
          SELECT LOWER("username") FROM "users"
           WHERE "username" IS NOT NULL
           GROUP BY LOWER("username") HAVING COUNT(*) > 1)
      ORDER BY LOWER("username"), "id"`,
  )) as Array<{ id: number; username: string }>;
  let renamed = 0;
  if (rows.length > 0) {
    const all = (await queryRunner.query(
      `SELECT LOWER("username") AS "u" FROM "users" WHERE "username" IS NOT NULL`,
    )) as Array<{ u: string }>;
    const taken = new Set(all.map((r) => r.u));
    const seen = new Set<string>();
    for (const row of rows) {
      const key = row.username.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key); // the lowest id keeps its username
        continue;
      }
      let n = 2;
      while (taken.has(`${key}${n}`)) n++;
      const next = `${row.username}${n}`;
      taken.add(next.toLowerCase());
      await queryRunner.query(
        `UPDATE "users" SET "username" = $1 WHERE "id" = $2`,
        [next, row.id],
      );
      renamed++;
    }
  }
  await queryRunner.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_username_lower"
       ON "users" (LOWER("username")) WHERE "username" IS NOT NULL`,
  );
  new Logger('UsernameUniqueIndex').log(
    `Usernames renamed to resolve case-insensitive duplicates: ${renamed}`,
  );
  return renamed;
}
