import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * QA AUTH-04: emails were stored as typed, so `Ama@Example.com` and
 * `ama@example.com` could be two accounts, and logging in with a different
 * case failed. New addresses are now stored lowercase and looked up
 * case-insensitively; this lowercases the existing rows.
 *
 * An address that already exists in two cases can't be merged automatically
 * (both accounts may hold data), so those rows are left as they are and only
 * counted in the log line for support to resolve. The case-insensitive unique
 * index is created only when no such pair remains, so the migration never
 * fails on live data.
 */
export class NormalizeUserEmailCase1783250000000 implements MigrationInterface {
  name = 'NormalizeUserEmailCase1783250000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const changed = (await queryRunner.query(`
      UPDATE "users" u SET "email" = LOWER(u."email")
       WHERE u."email" <> LOWER(u."email")
         AND NOT EXISTS (
           SELECT 1 FROM "users" o
            WHERE o."id" <> u."id" AND LOWER(o."email") = LOWER(u."email")
         )
      RETURNING u."id"
    `)) as unknown[];
    const [{ count }] = (await queryRunner.query(`
      SELECT COUNT(*)::text AS count FROM (
        SELECT LOWER("email") FROM "users" GROUP BY LOWER("email") HAVING COUNT(*) > 1
      ) dupes
    `)) as Array<{ count: string }>;
    console.log(
      `[${this.name}] lowercased ${changed.length} email(s); ${count} address(es) exist in more than one case and were left for support`,
    );
    if (count === '0') {
      await queryRunner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_email_lower" ON "users" (LOWER("email"))`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The original casing isn't kept, so only the index is undone.
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_users_email_lower"`);
  }
}
