import { MigrationInterface, QueryRunner } from 'typeorm';

const OLD_EVENTS =
  "'payment_settings.updated','spending_report.exported','profile_photo.removed','payment_method.added','payment_method.removed'";

/** Auth v2 event names. Mirrored by `SECURITY_EVENT_NAMES`. */
export const AUTH_V2_EVENTS = [
  'auth.signup',
  'auth.code_sent',
  'auth.code_failed',
  'auth.code_locked',
  'auth.login',
  'auth.password_reset',
] as const;

const NEW_EVENTS = `${OLD_EVENTS},${AUTH_V2_EVENTS.map((e) => `'${e}'`).join(',')}`;

/**
 * Auth v2: lets the security log record sign-ups, codes sent, failed and
 * locked code checks, sign-ins (with the method) and password resets. Names
 * and small flags only — never a code or a password. Idempotent: the
 * constraint is dropped if present and recreated.
 */
export class AddAuthSecurityEvents1783380000000 implements MigrationInterface {
  name = 'AddAuthSecurityEvents1783380000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "account_security_events" DROP CONSTRAINT IF EXISTS "chk_account_security_events_event"`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_security_events" ADD CONSTRAINT "chk_account_security_events_event" CHECK ("event" IN (${NEW_EVENTS}))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "account_security_events" WHERE "event" = ANY($1)`,
      [[...AUTH_V2_EVENTS]],
    );
    await queryRunner.query(
      `ALTER TABLE "account_security_events" DROP CONSTRAINT IF EXISTS "chk_account_security_events_event"`,
    );
    await queryRunner.query(
      `ALTER TABLE "account_security_events" ADD CONSTRAINT "chk_account_security_events_event" CHECK ("event" IN (${OLD_EVENTS}))`,
    );
  }
}
