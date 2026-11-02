import type { QueryRunner } from 'typeorm';
import {
  SERVICE_CATALOGUE,
  SeedServiceCatalogue1783350000000,
} from '../1783350000000-SeedServiceCatalogue';

/**
 * The SQL shape of the catalogue migration. Its behaviour against a real
 * database (8 rows, idempotent, existing rows untouched, safe down()) is
 * covered by test/service-catalogue.e2e-spec.ts.
 */
describe('SeedServiceCatalogue migration', () => {
  function runner() {
    const query = jest.fn().mockResolvedValue([]);
    return { runner: { query } as unknown as QueryRunner, query };
  }

  it('holds the 8 seed service types, each with a description', () => {
    expect(SERVICE_CATALOGUE.map((s) => s.name)).toEqual([
      'Plumbing',
      'Electrical',
      'Hair Braiding',
      'Carpentry',
      'Painting',
      'Tiling',
      'Cleaning',
      'Landscaping',
    ]);
    for (const s of SERVICE_CATALOGUE) expect(s.description).toBeTruthy();
  });

  it('up() inserts names and descriptions only, skipping any name in any case', async () => {
    const { runner: qr, query } = runner();
    await new SeedServiceCatalogue1783350000000().up(qr);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, string[]];
    expect(sql).toContain('INSERT INTO "services" ("name", "description")');
    expect(sql).toContain('LOWER(s."name") = LOWER(v."name")');
    expect(sql).toContain('ON CONFLICT ("name") DO NOTHING');
    expect(sql).not.toMatch(/price|estimated_duration/);
    expect(params).toHaveLength(16);
    expect(params.slice(0, 2)).toEqual([
      'Plumbing',
      'Water supply, drainage, and piping services',
    ]);
  });

  it('down() deletes only unchanged, unpriced, unused catalogue rows', async () => {
    const { runner: qr, query } = runner();
    await new SeedServiceCatalogue1783350000000().down(qr);

    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain('s."description" = v."description"');
    expect(sql).toContain('s."price" IS NULL');
    for (const table of [
      'artisan_profile_services',
      'customer_profile_services',
      'jobs',
      'bookings',
    ]) {
      expect(sql).toContain(`FROM "${table}" x WHERE x."service_id" = s."id"`);
    }
  });
});
