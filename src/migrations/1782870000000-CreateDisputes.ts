import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDisputes1782870000000 implements MigrationInterface {
  name = 'CreateDisputes1782870000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."disputes_status_enum" AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CLOSED')
    `);

    await queryRunner.query(`
      CREATE TABLE "disputes" (
        "id"             SERIAL                                   NOT NULL,
        "booking_id"     INTEGER                                  NOT NULL,
        "raised_by_id"   INTEGER                                  NOT NULL,
        "reason"         TEXT                                     NOT NULL,
        "status"         "public"."disputes_status_enum"         NOT NULL DEFAULT 'OPEN',
        "admin_notes"    TEXT,
        "resolution"     TEXT,
        "resolved_by_id" INTEGER,
        "resolved_at"    TIMESTAMP WITH TIME ZONE,
        "created_at"     TIMESTAMP                               NOT NULL DEFAULT now(),
        "updated_at"     TIMESTAMP                               NOT NULL DEFAULT now(),
        CONSTRAINT "pk_disputes" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "disputes"
        ADD CONSTRAINT "fk_disputes_booking_id"
        FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "disputes"
        ADD CONSTRAINT "fk_disputes_raised_by_id"
        FOREIGN KEY ("raised_by_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "disputes"
        ADD CONSTRAINT "fk_disputes_resolved_by_id"
        FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL
    `);

    await queryRunner.query(`CREATE INDEX "idx_disputes_booking_id"   ON "disputes" ("booking_id")`);
    await queryRunner.query(`CREATE INDEX "idx_disputes_raised_by_id" ON "disputes" ("raised_by_id")`);
    await queryRunner.query(`CREATE INDEX "idx_disputes_status"       ON "disputes" ("status")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_disputes_status"`);
    await queryRunner.query(`DROP INDEX "idx_disputes_raised_by_id"`);
    await queryRunner.query(`DROP INDEX "idx_disputes_booking_id"`);
    await queryRunner.query(`ALTER TABLE "disputes" DROP CONSTRAINT "fk_disputes_resolved_by_id"`);
    await queryRunner.query(`ALTER TABLE "disputes" DROP CONSTRAINT "fk_disputes_raised_by_id"`);
    await queryRunner.query(`ALTER TABLE "disputes" DROP CONSTRAINT "fk_disputes_booking_id"`);
    await queryRunner.query(`DROP TABLE "disputes"`);
    await queryRunner.query(`DROP TYPE "public"."disputes_status_enum"`);
  }
}
