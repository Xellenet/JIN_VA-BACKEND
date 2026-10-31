import { TtlCache } from './customer-cache';

describe('TtlCache', () => {
  it('serves a value until its TTL passes', () => {
    let now = 1000;
    const cache = new TtlCache<string>(60_000, 10, () => now);
    cache.set('customer-analytics:1:12m', 'a');
    expect(cache.get('customer-analytics:1:12m')).toBe('a');
    now += 59_999;
    expect(cache.get('customer-analytics:1:12m')).toBe('a');
    now += 1;
    expect(cache.get('customer-analytics:1:12m')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts the oldest entry at the cap', () => {
    const cache = new TtlCache<number>(60_000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 3); // re-set moves "a" to newest
    cache.set('c', 4);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(3);
    expect(cache.get('c')).toBe(4);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
