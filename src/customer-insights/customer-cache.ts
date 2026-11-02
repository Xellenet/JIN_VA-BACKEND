/**
 * Customer experience v2: a tiny in-process TTL cache for the per-user
 * overview (30 s) and spending analytics (60 s).
 *
 * Keys always carry the user id (`customer-overview:{id}`,
 * `customer-analytics:{id}:{range}`), so one customer can never be served
 * another's figures. Entries expire on read; once `maxEntries` is reached the
 * oldest entry is evicted first. Like the throttler storage, it is per
 * process, which only means a little more recomputation behind a load
 * balancer. Account purge needs no eviction hook: entries are gone within a
 * minute (SEC-37).
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 2000,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest: IteratorResult<string> = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.clock() + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
