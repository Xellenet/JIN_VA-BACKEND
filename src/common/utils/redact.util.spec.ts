import { PassThrough } from 'stream';
import * as winston from 'winston';
import {
  REDACTED,
  REDACTED_LOG_KEYS,
  isRedactedKey,
  redactLogInfo,
  redactSensitive,
} from './redact.util';
import { redactFormat } from '../../config/winston.config';

describe('redactSensitive (SEC-31)', () => {
  it('covers every key the plan names', () => {
    expect([...REDACTED_LOG_KEYS].sort()).toEqual(
      [
        'password',
        'currentPassword',
        'code',
        'otp',
        'momoNumber',
        'phoneNumber',
        'email',
        'accountNumber',
        'payoutAccountNumber',
        'payout_account_number',
        'authorization',
        'authorization_code',
        'authorization_url',
        'access_code',
        'card',
        'nationalId',
      ].sort(),
    );
  });

  it('redacts every momo_number* key by prefix, and nothing that merely contains it', () => {
    for (const key of [
      'momo_number',
      'momo_number_encrypted',
      'MOMO_NUMBER_LAST4',
      'momoNumber',
      'momoNumberEncrypted',
    ]) {
      expect(isRedactedKey(key)).toBe(true);
    }
    expect(isRedactedKey('has_momo_number')).toBe(false);
    expect(isRedactedKey('momo_provider')).toBe(false);
    expect(
      redactSensitive({
        settings: { momo_number_encrypted: 'cipher', momo_provider: 'mtn' },
        access_code: 'fictional-code',
        authorization_url: 'https://checkout.example.test/x',
      }),
    ).toEqual({
      settings: { momo_number_encrypted: REDACTED, momo_provider: 'mtn' },
      access_code: REDACTED,
      authorization_url: REDACTED,
    });
  });

  it('redacts at any depth, case-insensitively, inside arrays too', () => {
    const input = {
      userId: 4,
      Email: 'ama.owusu@example.com',
      body: {
        phoneNumber: '+233241234567',
        nested: [{ authorization: { authorization_code: 'AUTH_x' } }],
        card: { last4: '4081' },
      },
      list: [{ otp: '123456' }, 'plain'],
    };
    expect(redactSensitive(input)).toEqual({
      userId: 4,
      Email: REDACTED,
      body: {
        phoneNumber: REDACTED,
        nested: [{ authorization: REDACTED }],
        card: REDACTED,
      },
      list: [{ otp: REDACTED }, 'plain'],
    });
  });

  it('never mutates the input', () => {
    const input = { password: 'secret', nested: { email: 'a@example.com' } };
    redactSensitive(input);
    expect(input).toEqual({
      password: 'secret',
      nested: { email: 'a@example.com' },
    });
  });

  it('survives cycles and leaves non-plain values alone', () => {
    const cyclic: Record<string, unknown> = { password: 'x' };
    cyclic.self = cyclic;
    const out = redactSensitive(cyclic);
    expect(out.password).toBe(REDACTED);
    expect((out.self as Record<string, unknown>).password).toBe(REDACTED);

    const date = new Date(0);
    expect(redactSensitive({ at: date }).at).toBe(date);
    expect(redactSensitive('text')).toBe('text');
  });

  it('stops at a sane depth', () => {
    let deep: Record<string, unknown> = { password: 'bottom' };
    for (let i = 0; i < 20; i++) deep = { inner: deep };
    expect(() => redactSensitive(deep)).not.toThrow();
  });
});

describe('redactLogInfo', () => {
  it('redacts metadata keys but never the level or message', () => {
    const info = {
      level: 'info',
      message: 'hello',
      email: 'ama.owusu@example.com',
      meta: { code: '999111' },
    };
    expect(redactLogInfo(info)).toEqual({
      level: 'info',
      message: 'hello',
      email: REDACTED,
      meta: { code: REDACTED },
    });
  });
});

describe('winston redact format (O-1)', () => {
  it('keeps sensitive values out of a real log line', () => {
    const sink = new PassThrough();
    const lines: string[] = [];
    sink.on('data', (chunk: Buffer) => lines.push(chunk.toString()));
    const logger = winston.createLogger({
      format: winston.format.combine(redactFormat(), winston.format.json()),
      transports: [new winston.transports.Stream({ stream: sink })],
    });

    const meta = {
      email: 'ama.owusu@example.com',
      phoneNumber: '+233241234567',
      momoNumber: '+233201234567',
      authorization: 'Bearer abc.def',
      ok: 'kept',
    };
    logger.info('payment settings saved', meta);

    const line = lines.join('');
    expect(line).toContain('kept');
    for (const value of [
      'ama.owusu@example.com',
      '+233241234567',
      '+233201234567',
      'Bearer abc.def',
    ]) {
      expect(line).not.toContain(value);
    }
    // The caller's object is untouched.
    expect(meta.email).toBe('ama.owusu@example.com');
  });
});
