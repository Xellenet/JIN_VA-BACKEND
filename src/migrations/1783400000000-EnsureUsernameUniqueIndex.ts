import { MigrationInterface, QueryRunner } from 'typeorm';
import { dedupeUsernamesAndCreateIndex } from '../database/migration-helpers/username-dedupe';

/**
 * Re-runs the username de-duplication and unique index from
 * `AddUsernameUniqueIndex1783390000000`. An earlier draft of that migration
 * skipped the index when duplicates existed; a database that ran the draft
 * gets the duplicates resolved and the index built here. On any other
 * database this finds nothing to rename and the index already exists, so it
 * changes nothing.
 */
export class EnsureUsernameUniqueIndex1783400000000
  implements MigrationInterface
{
  name = 'EnsureUsernameUniqueIndex1783400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await dedupeUsernamesAndCreateIndex(queryRunner);
  }

  /** The index belongs to 1783390000000; its `down` drops it. */
  public async down(): Promise<void> {}
}
