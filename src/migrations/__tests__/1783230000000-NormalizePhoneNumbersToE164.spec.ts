import type { QueryRunner } from 'typeorm';
import { NormalizePhoneNumbersToE1641783230000000 } from '../1783230000000-NormalizePhoneNumbersToE164';

/** PH10: the E.164 migration, against an in-memory stand-in for `users`. */
describe('NormalizePhoneNumbersToE164 migration (PH10)', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => logSpy.mockRestore());

  function runnerFor(rows: Array<{ id: number; phone_number: string }>) {
    const query = jest.fn((sql: string) => {
      if (sql.startsWith('SELECT')) return Promise.resolve(rows);
      return Promise.resolve([[], 1]);
    });
    return { runner: { query } as unknown as QueryRunner, query };
  }

  const updatesOf = (query: jest.Mock) =>
    query.mock.calls
      .filter(([sql]) => String(sql).startsWith('UPDATE'))
      .map(([, params]) => params as [string, number]);

  it('converts national and spaced forms, skips E.164 rows, leaves invalid ones alone', async () => {
    const { runner, query } = runnerFor([
      { id: 1, phone_number: '020-000-0001' },
      { id: 2, phone_number: '024 123 4567' },
      { id: 3, phone_number: '+233201110001' },
      { id: 4, phone_number: '123-456-7890' },
      { id: 5, phone_number: '' },
    ]);

    await new NormalizePhoneNumbersToE1641783230000000().up(runner);

    expect(updatesOf(query)).toEqual([
      ['+233200000001', 1],
      ['+233241234567', 2],
    ]);
    const line = String((logSpy.mock.calls as unknown[][])[0][0]);
    expect(line).toContain('2 converted to E.164');
    expect(line).toContain('1 already E.164');
    expect(line).toContain('2 left unchanged as unparseable (user ids 4, 5)');
    // No number, in any spelling, reaches the log.
    for (const fragment of [
      '020-000-0001',
      '200000001',
      '1234567',
      '456-7890',
    ]) {
      expect(line).not.toContain(fragment);
    }
  });

  it('aborts before writing anything when two rows would share one number', async () => {
    const { runner, query } = runnerFor([
      { id: 7, phone_number: '024-123-4567' },
      { id: 8, phone_number: '+233241234567' },
      { id: 9, phone_number: '020-000-0001' },
    ]);

    await expect(
      new NormalizePhoneNumbersToE1641783230000000().up(runner),
    ).rejects.toThrow(/aborted, nothing changed.*user ids 7, 8/);
    expect(updatesOf(query)).toEqual([]);
  });

  it('down() rewrites Ghanaian E.164 numbers to the legacy dashed form', async () => {
    const { runner, query } = runnerFor([]);
    await new NormalizePhoneNumbersToE1641783230000000().down(runner);

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain(`'^\\+233[0-9]{9}$'`);
    expect(sql).toContain('substr("phone_number", 5, 2)');
  });
});
