import { MigrationInterface, QueryRunner } from 'typeorm';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * PH10 (google-signup-prefill): rewrites every stored `users.phone_number` to
 * E.164 (`020-000-0001` → `+233200000001`).
 *
 * The API now normalises every submitted number to E.164 (PH7), so stored
 * numbers have to be in the same form — otherwise `024…` and `+233 24…` would
 * be two different strings to the `phone_number` unique index and a duplicate
 * could slip past it (R6, PH9).
 *
 * Rules, per the requirements:
 * - National forms are read as Ghanaian (the only market so far; every row
 *   written under the old `XXX-XXX-XXXX` validator is national).
 * - A value that doesn't parse as a **valid** number is **left unchanged**
 *   (never nulled) and reported by **user id only**. No phone number is ever
 *   written to the log.
 * - If two rows would end up with the same E.164 value, the migration
 *   **aborts before writing anything**, naming the colliding user ids, so the
 *   unique index can never fail half-way.
 * - Everything runs in the migration transaction (TypeORM's default
 *   `transaction: "all"` for `migrationsRun`), so a failure leaves no row
 *   changed.
 *
 * Soft-deleted rows are included on purpose: the unique index spans them.
 * Purged rows already hold `NULL`.
 *
 * Deliberately self-contained (the library is imported directly, not through
 * `phone-number.util`): a migration describes what happened on its date and
 * must not change behaviour when application code does.
 */
export class NormalizePhoneNumbersToE1641783230000000
  implements MigrationInterface
{
  name = 'NormalizePhoneNumbersToE1641783230000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT "id", "phone_number" FROM "users" WHERE "phone_number" IS NOT NULL`,
    )) as Array<{ id: number; phone_number: string }>;

    const updates: Array<{ id: number; value: string }> = [];
    const unparseable: number[] = [];
    let alreadyE164 = 0;
    /** The value each row will hold afterwards, for the collision check. */
    const finalOwners = new Map<string, number[]>();

    for (const row of rows) {
      const parsed = parsePhoneNumberFromString(row.phone_number, 'GH');
      let finalValue = row.phone_number;
      if (parsed?.isValid()) {
        finalValue = parsed.number;
        if (finalValue === row.phone_number) alreadyE164 += 1;
        else updates.push({ id: row.id, value: finalValue });
      } else {
        unparseable.push(row.id);
      }
      const owners = finalOwners.get(finalValue) ?? [];
      owners.push(row.id);
      finalOwners.set(finalValue, owners);
    }

    const collisions = [...finalOwners.values()].filter(
      (ids) => ids.length > 1,
    );
    if (collisions.length > 0) {
      const described = collisions
        .map((ids) => `[user ids ${ids.join(', ')}]`)
        .join('; ');
      throw new Error(
        `[${this.name}] aborted, nothing changed: ${collisions.length} group(s) of users ` +
          `would share one E.164 phone number: ${described}. Resolve these by hand, then re-run.`,
      );
    }

    for (const { id, value } of updates) {
      await queryRunner.query(
        `UPDATE "users" SET "phone_number" = $1 WHERE "id" = $2`,
        [value, id],
      );
    }

    console.log(
      `[${this.name}] ${rows.length} phone number(s) checked: ${updates.length} converted to E.164, ` +
        `${alreadyE164} already E.164, ${unparseable.length} left unchanged as unparseable` +
        (unparseable.length > 0 ? ` (user ids ${unparseable.join(', ')})` : ''),
    );
  }

  /**
   * Reverts Ghanaian numbers to the legacy `0XX-XXX-XXXX` form the previous
   * validator (`/^\d{3}-\d{3}-\d{4}$/`) accepted, so the old code can read and
   * re-save them. This is derived from the number itself — no copy of the
   * original values is kept anywhere, by design (no extra store of personal
   * data).
   *
   * Caveat: a row that was stored in some other national spelling before
   * `up()` comes back in the dashed form, not its original spelling; it is the
   * same number. Non-Ghanaian or non-E.164 values are left untouched.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const result: unknown = await queryRunner.query(`
      UPDATE "users"
         SET "phone_number" = '0' || substr("phone_number", 5, 2) || '-'
                                  || substr("phone_number", 7, 3) || '-'
                                  || substr("phone_number", 10, 4)
       WHERE "phone_number" ~ '^\\+233[0-9]{9}$'
      RETURNING "id"
    `);
    const rows: unknown =
      Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
    console.log(
      `[${this.name}] down(): ${Array.isArray(rows) ? rows.length : 0} Ghanaian number(s) ` +
        `reverted to the legacy 0XX-XXX-XXXX form`,
    );
  }
}
