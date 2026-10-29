import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G5: brand-new Google signups never supply a `gender`, and this
 * remediation's chosen approach also leaves `password` unset for
 * social-only accounts (see G10) rather than generating a placeholder
 * value. Both columns must therefore accept NULL.
 */
export class MakeUserGenderAndPasswordNullable1782910000000
  implements MigrationInterface
{
  name = 'MakeUserGenderAndPasswordNullable1782910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ALTER COLUMN "gender" DROP NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ALTER COLUMN "password" DROP NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverting to NOT NULL would fail if any social-only account has a null
    // password/gender at revert time; that is expected — such accounts are a
    // direct product of this migration and must be fixed up (or removed)
    // before rolling it back.
    await queryRunner.query(`
      ALTER TABLE "users"
      ALTER COLUMN "password" SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ALTER COLUMN "gender" SET NOT NULL
    `);
  }
}
