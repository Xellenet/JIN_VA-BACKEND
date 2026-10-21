import { TtlLruCache } from './ttl-lru-cache';

describe('TtlLruCache', () => {
  let now = 0;
  const clock = () => now;

  beforeEach(() => {
    now = 0;
  });

  it('returns stored values until they expire', () => {
    const cache = new TtlLruCache<string>(10, 100, clock);
    cache.set('a', 'A');
    now = 99;
    expect(cache.get('a')).toBe('A');
    now = 100;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used entry past the bound', () => {
    const cache = new TtlLruCache<string>(2, 1_000, clock);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.get('a');
    cache.set('c', 'C');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('A');
    expect(cache.get('c')).toBe('C');
  });
});
