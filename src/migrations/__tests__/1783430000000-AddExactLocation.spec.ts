import { PGlite } from '@electric-sql/pglite';
import type { QueryRunner } from 'typeorm';
import { AddExactLocation1783430000000 } from '../1783430000000-AddExactLocation';

/** Against real Postgres (PGlite, in-process), with fictional rows. */
describe('AddExactLocation migration', () => {
  let db: PGlite;
  const runner = {
    query: async (sql: string, params: unknown[] = []) =>
      (await db.query(sql, params)).rows,
  } as unknown as QueryRunner;
  const migration = new AddExactLocation1783430000000();

  const columns = async (table: string) =>
    (
      await db.query<{
        column_name: string;
        data_type: string;
        numeric_precision: number | null;
        numeric_scale: number | null;
      }>(
        `SELECT column_name, data_type, numeric_precision, numeric_scale
           FROM information_schema.columns
          WHERE table_name = $1 ORDER BY column_name`,
        [table],
      )
    ).rows;

  beforeAll(async () => {
    db = await PGlite.create();
  }, 60000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec(`
      DROP TABLE IF EXISTS "jobs";
      DROP TABLE IF EXISTS "bookings";
      CREATE TABLE "jobs" (
        "id" SERIAL PRIMARY KEY,
        "location" character varying NOT NULL,
        "latitude" numeric(10,2),
        "longitude" numeric(10,2)
      );
      CREATE TABLE "bookings" ("id" SERIAL PRIMARY KEY);
      INSERT INTO "jobs" ("location", "latitude", "longitude") VALUES
        ('Adum, Kumasi', 6.69, -1.62),
        ('Half a pair', NULL, -1.62),
        ('Out of range', 1234.5, 2),
        ('No pin', NULL, NULL);
      INSERT INTO "bookings" DEFAULT VALUES;
    `);
  });

  it('widens the pin, adds the new columns, keeps good rows and can run twice', async () => {
    await migration.up(runner);
    await migration.up(runner);

    const jobs = await columns('jobs');
    expect(jobs.find((c) => c.column_name === 'latitude')).toMatchObject({
      numeric_precision: 9,
      numeric_scale: 6,
    });
    expect(jobs.map((c) => c.column_name)).toEqual(
      expect.arrayContaining(['location_accuracy_m', 'landmark']),
    );
    expect((await columns('bookings')).map((c) => c.column_name)).toEqual([
      'id',
      'landmark',
      'latitude',
      'location',
      'location_accuracy_m',
      'longitude',
    ]);

    const rows = await db.query(
      'SELECT "location", "latitude", "longitude" FROM "jobs" ORDER BY id',
    );
    expect(rows.rows).toEqual([
      {
        location: 'Adum, Kumasi',
        latitude: '6.690000',
        longitude: '-1.620000',
      },
      { location: 'Half a pair', latitude: null, longitude: null },
      { location: 'Out of range', latitude: null, longitude: null },
      { location: 'No pin', latitude: null, longitude: null },
    ]);
  });

  it('stores six decimals (about 0.1 m)', async () => {
    await migration.up(runner);
    await db.query(
      `UPDATE "jobs" SET "latitude" = 6.6885123, "longitude" = -1.6244456 WHERE id = 1`,
    );
    const row = await db.query(
      'SELECT "latitude", "longitude" FROM "jobs" WHERE id = 1',
    );
    expect(row.rows[0]).toEqual({
      latitude: '6.688512',
      longitude: '-1.624446',
    });
  });

  it('refuses half a pin or a negative accuracy', async () => {
    await migration.up(runner);
    await expect(
      db.query(`UPDATE "bookings" SET "latitude" = 6.7 WHERE id = 1`),
    ).rejects.toThrow(/CHK_bookings_coordinates_pair/);
    await expect(
      db.query(`UPDATE "jobs" SET "longitude" = NULL WHERE id = 1`),
    ).rejects.toThrow(/CHK_jobs_coordinates_pair/);
    await expect(
      db.query(`UPDATE "jobs" SET "location_accuracy_m" = -1 WHERE id = 1`),
    ).rejects.toThrow(/CHK_jobs_location_accuracy/);
  });

  it('down() restores the old shape and is safe to repeat', async () => {
    await migration.up(runner);
    await migration.down(runner);
    await migration.down(runner);
    expect((await columns('bookings')).map((c) => c.column_name)).toEqual([
      'id',
    ]);
    const jobs = await columns('jobs');
    expect(jobs.map((c) => c.column_name)).toEqual([
      'id',
      'latitude',
      'location',
      'longitude',
    ]);
    expect(jobs.find((c) => c.column_name === 'latitude')).toMatchObject({
      numeric_precision: 10,
      numeric_scale: 2,
    });
  });
});
