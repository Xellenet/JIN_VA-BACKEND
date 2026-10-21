import { ArgumentsHost } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import {
  PHONE_NUMBER_IN_USE_ERROR_CODE,
  TypeOrmFilter,
} from './typeorm-exception.filter';

interface Body {
  status: string;
  message: string;
  meta: { statusCode: number; path: string; error?: string };
}

function run(code: string, detail: string): { status: number; body: Body } {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url: '/api/v1/auth/social/complete' }),
    }),
  } as unknown as ArgumentsHost;
  const err = Object.assign(
    new QueryFailedError('INSERT ...', [], new Error('duplicate key')),
    { code, detail },
  );

  const filter = new TypeOrmFilter();
  jest.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);
  filter.catch(err, host);

  return {
    status: (status.mock.calls[0] as unknown as [number])[0],
    body: (json.mock.calls[0] as unknown as [Body])[0],
  };
}

describe('TypeOrmFilter', () => {
  it('codes a duplicate phone number as PHONE_NUMBER_IN_USE (PH9)', () => {
    const { status, body } = run(
      '23505',
      'Key (phone_number)=(+233241234567) already exists.',
    );
    expect(status).toBe(409);
    expect(body.message).toBe('Phone number already in use');
    expect(body.meta.error).toBe(PHONE_NUMBER_IN_USE_ERROR_CODE);
    expect(body.meta.error).toBe('PHONE_NUMBER_IN_USE');
    // The conflicting value is never echoed back.
    expect(JSON.stringify(body)).not.toContain('+233241234567');
  });

  it('leaves other duplicates without a code', () => {
    const { status, body } = run(
      '23505',
      'Key (username)=(someone) already exists.',
    );
    expect(status).toBe(409);
    expect(body.message).toBe('Username already exists');
    expect(body.meta).not.toHaveProperty('error');
  });

  it('maps other driver errors to a generic 500', () => {
    const { status, body } = run('42P01', '');
    expect(status).toBe(500);
    expect(body.meta).not.toHaveProperty('error');
  });
});
