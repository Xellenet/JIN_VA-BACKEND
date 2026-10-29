import { MigrationInterface, QueryRunner } from 'typeorm';

/** PF1: greenfield Portfolio module — artisan photo/video uploads pending moderation. */
export class CreatePortfolioItems1782920000000 implements MigrationInterface {
  name = 'CreatePortfolioItems1782920000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "portfolio_items" (
        "id"                SERIAL PRIMARY KEY,
        "artisan_id"        INTEGER NOT NULL,
        "file_url"          TEXT NOT NULL,
        "file_type"         VARCHAR(100) NOT NULL,
        "caption"           TEXT,
        "tag"               VARCHAR(100),
        "status"            VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        "rejection_reason"  TEXT,
        "sort_order"        INTEGER NOT NULL DEFAULT 0,
        "created_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "fk_portfolio_items_artisan"
          FOREIGN KEY ("artisan_id")
          REFERENCES "artisan_profiles" ("id")
          ON DELETE CASCADE,
        CONSTRAINT "chk_portfolio_items_status"
          CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_portfolio_items_artisan_id"
        ON "portfolio_items" ("artisan_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_portfolio_items_status"
        ON "portfolio_items" ("status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "portfolio_items"`);
  }
}
