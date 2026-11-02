import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  parseYmd,
  PaymentHistoryExportQueryDto,
  PaymentHistoryQueryDto,
  spanExceedsMonths,
} from './payment-history-query.dto';

const check = async (
  query: Record<string, unknown>,
  cls: new () => object = PaymentHistoryQueryDto,
) => {
  const dto = plainToInstance(cls, query);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return {
    dto: dto as PaymentHistoryQueryDto,
    props: errors.map((e) => e.property),
  };
};

describe('PaymentHistoryQueryDto (BU-4.13)', () => {
  it.each([
    [{ limit: '101' }, 'limit'],
    [{ page: '0' }, 'page'],
    [{ page: '1001' }, 'page'],
    [{ search: 'x'.repeat(101) }, 'search'],
    [{ search: '   ' }, 'search'],
    [{ from: '2026-10-30', to: '2026-01-01' }, 'to'],
    [{ from: '2024-01-01', to: '2026-10-30' }, 'to'],
    [{ status: 'HELD,FOO' }, 'status'],
    [{ status: ',' }, 'status'],
    [{ serviceId: 'abc' }, 'serviceId'],
    [{ artisanProfileId: '0' }, 'artisanProfileId'],
    [{ range: '7d' }, 'range'],
    [{ range: '12m', from: '2026-01-01' }, 'range'],
    [{ from: '2026-02-30' }, 'from'],
    [{ from: '30-10-2026' }, 'from'],
    [{ customerId: '3' }, 'customerId'],
    [{ sort: 'amount' }, 'sort'],
  ])('rejects %p on %p', async (query, prop) => {
    expect((await check(query)).props).toContain(prop);
  });

  it('accepts a full valid query and normalises it', async () => {
    const { dto, props } = await check({
      page: '2',
      limit: '100',
      status: 'HELD, RELEASED,HELD',
      from: '2024-11-01',
      to: '2026-10-30',
      serviceId: '3',
      artisanProfileId: '57',
      search: '  rewire  ',
    });
    expect(props).toEqual([]);
    expect(dto).toMatchObject({
      page: 2,
      limit: 100,
      status: ['HELD', 'RELEASED'],
      serviceId: 3,
      artisanProfileId: 57,
      search: 'rewire',
    });
  });

  it('accepts a range on its own and a single date bound', async () => {
    expect((await check({ range: 'all' })).props).toEqual([]);
    expect((await check({ from: '2026-01-01' })).props).toEqual([]);
    expect((await check({ to: '2026-01-01' })).props).toEqual([]);
  });

  it('the export DTO refuses page and limit but keeps the filters', async () => {
    expect(
      (await check({ page: '1' }, PaymentHistoryExportQueryDto)).props,
    ).toContain('page');
    expect(
      (await check({ limit: '5' }, PaymentHistoryExportQueryDto)).props,
    ).toContain('limit');
    expect(
      (await check({ status: 'FOO' }, PaymentHistoryExportQueryDto)).props,
    ).toContain('status');
    expect(
      (await check({ range: '12m' }, PaymentHistoryExportQueryDto)).props,
    ).toEqual([]);
  });

  it('span helpers count calendar months', () => {
    const from = parseYmd('2024-10-30');
    expect(spanExceedsMonths(from, parseYmd('2026-10-30'), 24)).toBe(false);
    expect(spanExceedsMonths(from, parseYmd('2026-10-31'), 24)).toBe(true);
  });
});
