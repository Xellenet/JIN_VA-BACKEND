import { stripVTControlCharacters } from 'util';
import { PlatformTools } from 'typeorm/platform/PlatformTools';
import { ParameterlessQueryLogger } from './typeorm-logger';

describe('ParameterlessQueryLogger', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs a failed query and its error without the bound parameters', () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    jest.spyOn(PlatformTools, 'logError').mockImplementation(capture);
    jest.spyOn(PlatformTools, 'logWarn').mockImplementation(capture);
    jest.spyOn(console, 'log').mockImplementation(capture);
    jest.spyOn(console, 'warn').mockImplementation(capture);
    jest.spyOn(console, 'error').mockImplementation(capture);

    new ParameterlessQueryLogger(['error']).logQueryError(
      'QueryFailedError: duplicate key value violates unique constraint',
      'INSERT INTO "users"("email", "phone_number") VALUES ($1, $2)',
      ['esi.sample@example.com', '+233241234567'],
    );

    // TypeORM colours the SQL when colour output is on (as it is in CI), so
    // compare the text without the colour codes.
    const out = stripVTControlCharacters(lines.join('\n'));
    expect(out).toContain('INSERT INTO "users"');
    expect(out).toContain('duplicate key value');
    expect(out).not.toContain('esi.sample@example.com');
    expect(out).not.toContain('+233241234567');
    expect(out).not.toContain('PARAMETERS');
  });
});
