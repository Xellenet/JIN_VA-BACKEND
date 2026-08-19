import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateNotificationPreferences1782300000000 implements MigrationInterface {
  name = 'CreateNotificationPreferences1782300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "notification_preferences" (
        "id"                       SERIAL   NOT NULL,
        "user_id"                  integer  NOT NULL,

        -- Channels (both roles)
        "email_enabled"            boolean  NOT NULL DEFAULT true,
        "sms_enabled"              boolean  NOT NULL DEFAULT false,
        "push_enabled"             boolean  NOT NULL DEFAULT true,

        -- Customer notification types
        "booking_confirmations"    boolean  NOT NULL DEFAULT true,
        "job_status_updates"       boolean  NOT NULL DEFAULT true,
        "payment_receipts"         boolean  NOT NULL DEFAULT true,
        "promotional_offers"       boolean  NOT NULL DEFAULT false,
        "service_reminders"        boolean  NOT NULL DEFAULT true,
        "review_requests"          boolean  NOT NULL DEFAULT true,

        -- Artisan notification types
        "new_job_opportunities"    boolean  NOT NULL DEFAULT true,
        "application_updates"      boolean  NOT NULL DEFAULT true,
        "artisan_job_updates"      boolean  NOT NULL DEFAULT true,
        "payment_released"         boolean  NOT NULL DEFAULT true,
        "reviews_and_ratings"      boolean  NOT NULL DEFAULT true,
        "artisan_promotions"       boolean  NOT NULL DEFAULT false,

        -- Shared
        "message_received"         boolean  NOT NULL DEFAULT true,

        CONSTRAINT "PK_notification_preferences" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_notification_preferences_user" UNIQUE ("user_id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "notification_preferences"
      ADD CONSTRAINT "FK_notification_preferences_user"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notification_preferences" DROP CONSTRAINT "FK_notification_preferences_user"`);
    await queryRunner.query(`DROP TABLE "notification_preferences"`);
  }
}
