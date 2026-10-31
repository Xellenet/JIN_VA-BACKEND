import type { ConfigService } from '@nestjs/config';
import {
  buildThrottlerOptions,
  CUSTOMER_THROTTLER_DEFAULTS,
} from './throttling.module';
import { THROTTLER_NAMES } from './throttler-names';

function configWith(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: jest.fn((key: string, fallback?: unknown) =>
      key in values ? values[key] : fallback,
    ),
  } as unknown as ConfigService;
}

function byName(config: ConfigService) {
  const { throttlers } = buildThrottlerOptions(config);
  return new Map(throttlers.map((t) => [t.name, t]));
}

describe('ThrottlingModule configuration', () => {
  it('registers every named throttler exactly once', () => {
    const { throttlers } = buildThrottlerOptions(configWith());
    const names = throttlers.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(Object.values(THROTTLER_NAMES).sort());
  });

  it('uses the Customer Experience v2 default limits and windows', () => {
    const map = byName(configWith());
    expect(map.get(THROTTLER_NAMES.CUSTOMER_ANALYTICS)).toMatchObject({
      limit: 30,
      ttl: 60_000,
    });
    expect(map.get(THROTTLER_NAMES.CUSTOMER_EXPORT)).toMatchObject({
      limit: 5,
      ttl: 600_000,
    });
    expect(map.get(THROTTLER_NAMES.PAYMENT_SETTINGS_WRITE)).toMatchObject({
      limit: 5,
      ttl: 60_000,
    });
    expect(map.get(THROTTLER_NAMES.PROFILE_MEDIA_WRITE)).toMatchObject({
      limit: 10,
      ttl: 3_600_000,
    });
    expect(map.get(THROTTLER_NAMES.NOTIFICATION_READ)).toMatchObject({
      limit: 60,
      ttl: 60_000,
    });
    expect(CUSTOMER_THROTTLER_DEFAULTS.CUSTOMER_EXPORT.ttl).toBe(600_000);
  });

  it('keeps the existing limits unchanged', () => {
    const map = byName(configWith());
    expect(map.get(THROTTLER_NAMES.MESSAGE_SEND)).toMatchObject({
      limit: 25,
      ttl: 60_000,
    });
    expect(map.get(THROTTLER_NAMES.AUTH_CREDENTIALS)).toMatchObject({
      limit: 10,
    });
    expect(map.get(THROTTLER_NAMES.AUTH_EMAIL)).toMatchObject({ limit: 5 });
    expect(map.get(THROTTLER_NAMES.DISPUTE_WRITE)).toMatchObject({
      limit: 20,
    });
  });

  it('reads each new limit from its environment override', () => {
    const map = byName(
      configWith({
        CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE: '3',
        CUSTOMER_EXPORT_RATE_LIMIT_PER_10_MINUTES: '2',
        PAYMENT_SETTINGS_WRITE_RATE_LIMIT_PER_MINUTE: 4,
        PROFILE_MEDIA_WRITE_RATE_LIMIT_PER_HOUR: '6',
        NOTIFICATION_READ_RATE_LIMIT_PER_MINUTE: '7.9',
      }),
    );
    expect(map.get(THROTTLER_NAMES.CUSTOMER_ANALYTICS)?.limit).toBe(3);
    expect(map.get(THROTTLER_NAMES.CUSTOMER_EXPORT)?.limit).toBe(2);
    expect(map.get(THROTTLER_NAMES.PAYMENT_SETTINGS_WRITE)?.limit).toBe(4);
    expect(map.get(THROTTLER_NAMES.PROFILE_MEDIA_WRITE)?.limit).toBe(6);
    expect(map.get(THROTTLER_NAMES.NOTIFICATION_READ)?.limit).toBe(7);
  });

  it('falls back to the default for a zero, negative or non-numeric override', () => {
    const map = byName(
      configWith({
        CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE: '0',
        CUSTOMER_EXPORT_RATE_LIMIT_PER_10_MINUTES: '-4',
        PAYMENT_SETTINGS_WRITE_RATE_LIMIT_PER_MINUTE: 'lots',
      }),
    );
    expect(map.get(THROTTLER_NAMES.CUSTOMER_ANALYTICS)?.limit).toBe(30);
    expect(map.get(THROTTLER_NAMES.CUSTOMER_EXPORT)?.limit).toBe(5);
    expect(map.get(THROTTLER_NAMES.PAYMENT_SETTINGS_WRITE)?.limit).toBe(5);
  });
});
