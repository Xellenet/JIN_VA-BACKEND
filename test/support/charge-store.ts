/**
 * A tiny in-memory stand-in for the `payment_charges` repository in unit
 * specs: `findOne`/`find`/`count`/`update`/`insert`/`save`/`create`, with
 * `where` matching on plain values and TypeORM `In(...)`. Used through the
 * transaction manager and the injected repository alike, so both see the
 * same rows.
 */
import type { PaymentCharge } from '../../src/payments/entities/payment-charge.entity';

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([k, v]) => {
    const val = row[k];
    if (v && typeof v === 'object' && '_type' in v && '_value' in v) {
      const op = v as { _type: string; _value: unknown };
      if (op._type === 'in') return (op._value as unknown[]).includes(val);
      if (op._type === 'lessThanOrEqual')
        return val != null && (val as number) <= (op._value as number);
      if (op._type === 'lessThan')
        return val != null && (val as number) < (op._value as number);
      return false;
    }
    return val === v;
  });
}

export function chargeStore(initial: Partial<PaymentCharge>[] = []) {
  const rows = new Map<number, PaymentCharge>();
  let nextId = 1;
  const add = (v: Partial<PaymentCharge>): PaymentCharge => {
    const row = {
      status: 'pending',
      refundAttempts: 0,
      createdAt: new Date(),
      ...v,
      id: v.id ?? nextId++,
    } as PaymentCharge;
    nextId = Math.max(nextId, row.id + 1);
    rows.set(row.id, row);
    return row;
  };
  initial.forEach(add);
  const find = (where: Where) =>
    [...rows.values()].filter((r) =>
      matches(r as unknown as Record<string, unknown>, where),
    );

  const repo = {
    rows,
    add,
    create: jest.fn((v: Partial<PaymentCharge>) => v),
    findOne: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(find(where).at(-1) ? { ...find(where).at(-1)! } : null),
    ),
    findOneOrFail: jest.fn(({ where }: { where: Where }) => {
      const hit = find(where).at(-1);
      return hit
        ? Promise.resolve({ ...hit })
        : Promise.reject(new Error('not found'));
    }),
    find: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(find(where).map((r) => ({ ...r }))),
    ),
    count: jest.fn(({ where }: { where: Where }) =>
      Promise.resolve(find(where).length),
    ),
    save: jest.fn((v: Partial<PaymentCharge>) => Promise.resolve(add(v))),
    insert: jest.fn((v: Partial<PaymentCharge>) => {
      add(v);
      return Promise.resolve({ identifiers: [] });
    }),
    update: jest.fn((where: Where, patch: Partial<PaymentCharge>) => {
      const hits = find(where);
      hits.forEach((r) => Object.assign(r, patch));
      return Promise.resolve({ affected: hits.length });
    }),
  };
  return repo;
}

export type ChargeStore = ReturnType<typeof chargeStore>;
