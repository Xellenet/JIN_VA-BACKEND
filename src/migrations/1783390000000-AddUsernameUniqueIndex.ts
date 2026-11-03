import { MigrationInterface, QueryRunner } from 'typeorm';
import { dedupeUsernamesAndCreateIndex } from '../database/migration-helpers/username-dedupe';

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
 * only if missing. The step lives in `database/migration-helpers/username-dedupe.ts`
 * (migration files may only export migrations: TypeORM loads every exported
 * function there as one) and `EnsureUsernameUniqueIndex1783400000000` runs it
 * again on a database that ran an earlier draft of this migration.
 */
export class AddUsernameUniqueIndex1783390000000 implements MigrationInterface {
  name = 'AddUsernameUniqueIndex1783390000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await dedupeUsernamesAndCreateIndex(queryRunner);
  }

  /** Drops the index. Renamed usernames are not put back (they were collisions). */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_users_username_lower"`);
  }
}
