import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBookings1782830000000 implements MigrationInterface {
  name = 'CreateBookings1782830000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "bookings" (
        "id"                   SERIAL PRIMARY KEY,
        "customer_id"          INTEGER NOT NULL,
        "artisan_profile_id"   INTEGER NOT NULL,
        "availability_slot_id" INTEGER,
        "scheduled_date"       DATE NOT NULL,
        "start_time"           TIME NOT NULL,
        "end_time"             TIME NOT NULL,
        "status"               VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        "notes"                TEXT,
        "artisan_notes"        TEXT,
        "agreed_price"         DECIMAL(10, 2),
        "currency"             VARCHAR(3) NOT NULL DEFAULT 'GHS',
        "created_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "fk_bookings_customer"
          FOREIGN KEY ("customer_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_bookings_artisan_profile"
          FOREIGN KEY ("artisan_profile_id") REFERENCES "artisan_profiles" ("id") ON DELETE CASCADE,
        CONSTRAINT "fk_bookings_slot"
          FOREIGN KEY ("availability_slot_id") REFERENCES "artisan_availability" ("id") ON DELETE SET NULL,
        CONSTRAINT "chk_bookings_status"
          CHECK ("status" IN ('PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'DECLINED')),
        CONSTRAINT "chk_bookings_times"
          CHECK ("end_time" > "start_time")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_bookings_customer_id"
        ON "bookings" ("customer_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_bookings_artisan_profile_id"
        ON "bookings" ("artisan_profile_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_bookings_status_date"
        ON "bookings" ("status", "scheduled_date")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "bookings"`);
  }
}
