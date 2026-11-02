import {
  centsToMoney,
  channelGroup,
  COUNTED_STATUSES,
  HELD_STATUSES,
  moneyString,
  shareOf,
  SpendService,
  toCents,
} from './spend.util';
import { qbMock } from './testing/qb-mock';
import { PaymentStatus } from '@common/types/enums';

describe('spend rules (helpers)', () => {
  it('BU-4.2 counts the five paid statuses; held is the first three', () => {
    expect([...COUNTED_STATUSES].sort()).toEqual(
      [
        'HELD',
        'PENDING_TRANSFER',
        'REFUNDED',
        'RELEASED',
        'TRANSFER_FAILED',
      ].sort(),
    );
    expect([...HELD_STATUSES]).toEqual([
      'HELD',
      'PENDING_TRANSFER',
      'TRANSFER_FAILED',
    ]);
    for (const s of [
      PaymentStatus.PENDING,
      PaymentStatus.FAILED,
      PaymentStatus.CANCELLED,
    ]) {
      expect(COUNTED_STATUSES).not.toContain(s);
    }
  });

  it('BU-2.8 money is always two decimals with no float artefacts', () => {
    expect(centsToMoney(toCents(0.1) + toCents(0.2))).toBe('0.30');
    expect(moneyString('1840')).toBe('1840.00');
    expect(moneyString('1500.5')).toBe('1500.50');
    expect(moneyString(null)).toBe('0.00');
    expect(moneyString('')).toBe('0.00');
    expect(moneyString('not a number')).toBe('0.00');
    expect(centsToMoney(-150)).toBe('-1.50');
    expect(centsToMoney(5)).toBe('0.05');
  });

  it('BU-4.10 folds channels into four groups', () => {
    expect(channelGroup('mobile_money')).toBe('mobile_money');
    expect(channelGroup('CARD')).toBe('card');
    expect(channelGroup('bank')).toBe('bank');
    expect(channelGroup('bank_transfer')).toBe('bank');
    expect(channelGroup('ussd')).toBe('other');
    expect(channelGroup(null)).toBe('other');
    expect(channelGroup(undefined)).toBe('other');
  });

  it('shares round to 3 decimals and are 0 for a zero total', () => {
    expect(shareOf(1, 3)).toBe(0.333);
    expect(shareOf(5, 0)).toBe(0);
  });
});

describe('SpendService', () => {
  const setup = (results: Parameters<typeof qbMock>[0]) => {
    const qb = qbMock(results);
    const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    return { qb, service: new SpendService(repo as never) };
  };

  it('scopes every query to the caller and the counted statuses (SEC-1)', () => {
    const { qb, service } = setup({});
    service.counted(42, new Date('2026-01-01'), new Date('2026-02-01'), {
      endExclusive: true,
    });
    expect(qb.where).toHaveBeenCalledWith('p.customer_id = :me', { me: 42 });
    expect(qb.params()).toMatchObject({ countedStatuses: COUNTED_STATUSES });
    expect(qb.sql()).toContain('< :windowTo');
    expect(qb.sql()).not.toContain('42');
  });

  it('BU-4.1 totals: net = gross − refunded', async () => {
    const { service } = setup({
      getRawOne: {
        gross: '1800.00',
        refunded: '300.00',
        released: '1000.00',
        count: '3',
      },
    });
    await expect(service.totals(1, null, new Date())).resolves.toEqual({
      grossCents: 180000,
      refundedCents: 30000,
      netCents: 150000,
      releasedCents: 100000,
      count: 3,
    });
  });

  it('totals of nothing are zero', async () => {
    const { service } = setup({ getRawOne: undefined });
    await expect(service.totals(1, null, new Date())).resolves.toMatchObject({
      netCents: 0,
      count: 0,
    });
  });

  it('netByBucket keys by bucket start with cents and counts', async () => {
    const { qb, service } = setup({
      getRawMany: [{ bucket: '2026-10-01', net: '1840.00', count: '2' }],
    });
    const map = await service.netByBucket(1, 'month', null, new Date());
    expect(map.get('2026-10-01')).toEqual({ cents: 184000, count: 2 });
    expect(qb.setParameter).toHaveBeenCalledWith('bucketUnit', 'month');
  });

  it('held, first payment, has-ever and previous-period helpers', async () => {
    expect(
      await setup({ getRawOne: { held: '650.00' } }).service.heldCents(1),
    ).toBe(65000);
    expect(
      await setup({
        getRawOne: { first: '2025-12-01T00:00:00Z' },
      }).service.firstPaymentDate(1),
    ).toEqual(new Date('2025-12-01T00:00:00Z'));
    expect(
      await setup({ getRawOne: { first: null } }).service.firstPaymentDate(1),
    ).toBeNull();
    expect(
      await setup({ getRawOne: { id: 3 } }).service.hasPaymentsEver(1),
    ).toBe(true);
    expect(
      await setup({ getRawOne: undefined }).service.hasPaymentsEver(1),
    ).toBe(false);
    expect(
      await setup({ getRawOne: { net: '9300.00' } }).service.netCentsBetween(
        1,
        new Date(0),
        new Date(),
      ),
    ).toBe(930000);
  });
});
