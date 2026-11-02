import { BadGatewayException } from '@nestjs/common';
import {
  BANK_LIST_TTL_MS,
  BankListService,
  bankNameFor,
  resetBankListCache,
  toBankOptions,
} from './bank-list';

describe('toBankOptions', () => {
  it('keeps active ghipss banks, de-duplicated by code and sorted by name', () => {
    expect(
      toBankOptions([
        { code: '2', name: ' Zenith Bank ', type: 'ghipss', active: true },
        { code: '1', name: 'Absa Bank Ghana', type: 'ghipss' },
        { code: '1', name: 'Absa duplicate', type: 'ghipss' },
        { code: 'MTN', name: 'MTN', type: 'mobile_money' },
        { code: '3', name: 'Closed Bank', type: 'ghipss', active: false },
        { code: '4', name: 'Deleted Bank', type: 'ghipss', is_deleted: true },
        { code: '', name: 'No code' },
        { name: 'Missing code' },
        null as never,
      ]),
    ).toEqual([
      { code: '1', name: 'Absa Bank Ghana' },
      { code: '2', name: 'Zenith Bank' },
    ]);
  });

  it('tolerates a missing list', () => {
    expect(toBankOptions(undefined as never)).toEqual([]);
  });
});

describe('BankListService', () => {
  const banks = [{ code: '280100', name: 'Access Bank', type: 'ghipss' }];
  let now = 1_000_000;

  beforeEach(() => {
    resetBankListCache();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  it('fetches once and serves the cache within 24 hours', async () => {
    const paystack = { listBanks: jest.fn().mockResolvedValue(banks) };
    const service = new BankListService(paystack as never);
    const [a, b] = await Promise.all([service.list(), service.list()]);
    await service.list();
    expect(a).toEqual([{ code: '280100', name: 'Access Bank' }]);
    expect(b).toBe(a);
    expect(paystack.listBanks).toHaveBeenCalledTimes(1);
    expect(paystack.listBanks).toHaveBeenCalledWith('ghana');
    expect(bankNameFor('280100')).toBe('Access Bank');
    expect(bankNameFor('nope')).toBeNull();
    expect(bankNameFor(null)).toBeNull();
  });

  it('refreshes after the TTL and serves the last good list on failure', async () => {
    const paystack = {
      listBanks: jest
        .fn()
        .mockResolvedValueOnce(banks)
        .mockRejectedValueOnce(new Error('down')),
    };
    const service = new BankListService(paystack as never);
    await service.list();
    now += BANK_LIST_TTL_MS + 1;
    await expect(service.list()).resolves.toEqual([
      { code: '280100', name: 'Access Bank' },
    ]);
    expect(paystack.listBanks).toHaveBeenCalledTimes(2);
  });

  it('answers 502 when there is no list at all', async () => {
    const paystack = { listBanks: jest.fn().mockResolvedValue([]) };
    const service = new BankListService(paystack as never);
    await expect(service.list()).rejects.toBeInstanceOf(BadGatewayException);
  });
});
