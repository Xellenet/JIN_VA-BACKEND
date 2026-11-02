import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import {
  PAYMENT_METHODS_DISABLED,
  PaymentDataEncryptionService,
} from './payment-data-encryption.service';

const config = (values: Record<string, string | undefined>) =>
  ({ get: (k: string) => values[k] }) as unknown as ConfigService;

describe('PaymentDataEncryptionService', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('without a key: starts, warns once, and every use answers 503', () => {
    const svc = new PaymentDataEncryptionService(config({}));
    expect(svc.isEnabled()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String((warn.mock.calls as unknown[][])[0][0])).toMatch(
      /PAYMENT_DATA_ENCRYPTION_KEY is not set/,
    );
    for (const use of [
      () => svc.encrypt('x'),
      () => svc.decrypt('x'),
      () => svc.hash('x'),
      () => svc.hashCandidates('x'),
    ]) {
      try {
        use();
        throw new Error('expected a 503');
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        expect(
          (err as ServiceUnavailableException).getResponse(),
        ).toMatchObject({ errorCode: PAYMENT_METHODS_DISABLED });
      }
    }
  });

  it('with a malformed key: starts disabled and logs an error without the value', () => {
    const svc = new PaymentDataEncryptionService(
      config({ PAYMENT_DATA_ENCRYPTION_KEY: 'c2hvcnQ=' }),
    );
    expect(svc.isEnabled()).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String((error.mock.calls as unknown[][])[0][0])).not.toContain(
      'c2hvcnQ=',
    );
  });

  it('with a key (and a previous one): encrypts, decrypts and hashes', () => {
    const prev = randomBytes(32).toString('base64');
    const old = new PaymentDataEncryptionService(
      config({ PAYMENT_DATA_ENCRYPTION_KEY: prev }),
    );
    const svc = new PaymentDataEncryptionService(
      config({
        PAYMENT_DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        PAYMENT_DATA_ENCRYPTION_KEY_PREVIOUS: prev,
      }),
    );
    expect(svc.isEnabled()).toBe(true);
    expect(svc.decrypt(svc.encrypt('0240000000'))).toBe('0240000000');
    expect(svc.decrypt(old.encrypt('AUTH_old'))).toBe('AUTH_old');
    expect(svc.hashCandidates('s')).toEqual([svc.hash('s'), old.hash('s')]);
    expect(warn).not.toHaveBeenCalled();
  });
});
