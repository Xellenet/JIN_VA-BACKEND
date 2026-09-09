import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C1.7: lets the account purge clear an artisan's KYC media references.
 *
 * `document_front_url` and `selfie_url` were created `NOT NULL`, which is
 * right for a submission but made the two most sensitive columns on the table
 * impossible to scrub. The purge deletes the stored objects and then nulls
 * these references, so a purged account keeps no pointer to a national-ID scan
 * or a photo of its owner's face — `artisan_verifications` was otherwise the
 * one place a "permanently deleted" account stayed fully re-identifiable.
 *
 * Only the constraint changes; no data is touched, and the columns are still
 * always populated on submission (`SubmitVerificationDto` requires both), so a
 * NULL here means "the owning account was purged" and nothing else.
 *
 * `id_number`, `full_legal_name`, `date_of_birth`, `additional_notes` and
 * `provider_raw_response` are already nullable, so the purge needs no schema
 * change for those.
 */
export class AllowNullableVerificationMedia1783200000000
  implements MigrationInterface
{
  name = 'AllowNullableVerificationMedia1783200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "artisan_verifications"
        ALTER COLUMN "document_front_url" DROP NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "artisan_verifications"
        ALTER COLUMN "selfie_url" DROP NOT NULL
    `);
  }

  /**
   * Reversible only while no row has been purged: restoring `NOT NULL` on a
   * table that already contains scrubbed rows would fail, and the honest
   * answer is that the scrubbed media cannot be brought back to satisfy the
   * constraint. The placeholder keeps `down()` runnable without inventing a
   * plausible-looking URL that resolves to nothing.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "artisan_verifications"
        SET "document_front_url" = 'purged'
        WHERE "document_front_url" IS NULL
    `);
    await queryRunner.query(`
      UPDATE "artisan_verifications"
        SET "selfie_url" = 'purged'
        WHERE "selfie_url" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "artisan_verifications"
        ALTER COLUMN "document_front_url" SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "artisan_verifications"
        ALTER COLUMN "selfie_url" SET NOT NULL
    `);
  }
}
