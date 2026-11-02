/**
 * Test-only: a chainable TypeORM `SelectQueryBuilder` stand-in for unit
 * specs. Every builder method returns the mock and is recorded in `calls`;
 * the terminal methods resolve the values given.
 */
export interface QbMockResults {
  getRawOne?: unknown;
  getRawMany?: unknown[];
  getCount?: number;
  getMany?: unknown[];
  /** Makes every terminal method reject with this error. */
  error?: Error;
}

export type QbMock = Record<string, jest.Mock> & {
  calls: Array<{ method: string; args: unknown[] }>;
  /** Every SQL string passed to a builder method, joined, for assertions. */
  sql: () => string;
  /** Every parameter object passed, merged. */
  params: () => Record<string, unknown>;
};

const TERMINALS = ['getRawOne', 'getRawMany', 'getCount', 'getMany'] as const;

export function qbMock(results: QbMockResults = {}): QbMock {
  const calls: QbMock['calls'] = [];
  const target: Record<string, unknown> = { calls };
  const proxy: QbMock = new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      if (prop === 'then') return undefined;
      const fn = jest.fn((...args: unknown[]) => {
        calls.push({ method: prop, args });
        if ((TERMINALS as readonly string[]).includes(prop)) {
          if (results.error) return Promise.reject(results.error);
          const fallback =
            prop === 'getCount' ? 0 : prop === 'getRawOne' ? undefined : [];
          const value = results[prop as keyof QbMockResults];
          return Promise.resolve(value === undefined ? fallback : value);
        }
        return proxy;
      });
      t[prop] = fn;
      return fn;
    },
  }) as QbMock;
  target.sql = () =>
    calls
      .flatMap((c) => c.args)
      .filter((a): a is string => typeof a === 'string')
      .join(' | ');
  target.params = () =>
    Object.assign(
      {},
      ...calls
        .flatMap((c) => c.args)
        .filter(
          (a) =>
            a &&
            typeof a === 'object' &&
            !Array.isArray(a) &&
            !(a instanceof Date),
        ),
    ) as Record<string, unknown>;
  return proxy;
}
