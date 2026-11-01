import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PayoutAccountService } from './payout-account.service';
import {
  ACCOUNT_LOOKUP_UNAVAILABLE,
  ACCOUNT_NAME_NOT_FOUND,
} from './payout-account';

describe('PayoutAccountService', () => {
  const paystack = { resolveAccount: jest.fn() };
  const banks = { list: jest.fn() };
  const service = new PayoutAccountService(paystack as never, banks as never);
  const momo = {
    type: 'mobile_money' as const,
    accountNumber: '0240000000',
    bankCode: 'MTN',
  };
  const bank = {
    type: 'bank' as const,
    accountNumber: '1234567890',
    bankCode: '280100',
  };

  beforeEach(() => {
    jest.resetAllMocks();
    banks.list.mockResolvedValue([{ code: '280100', name: 'Access Bank' }]);
  });

  it('returns the looked-up name for mobile money without the bank list', async () => {
    paystack.resolveAccount.mockResolvedValue({
      status: 'resolved',
      accountName: 'KOFI ASANTE',
    });
    await expect(service.resolve(momo)).resolves.toEqual({
      accountName: 'KOFI ASANTE',
    });
    expect(paystack.resolveAccount).toHaveBeenCalledWith('0240000000', 'MTN');
    expect(banks.list).not.toHaveBeenCalled();
  });

  it('checks a bank code against the cached bank list', async () => {
    paystack.resolveAccount.mockResolvedValue({
      status: 'resolved',
      accountName: 'KOFI ASANTE',
    });
    await expect(service.resolve(bank)).resolves.toEqual({
      accountName: 'KOFI ASANTE',
    });

    await expect(
      service.resolve({ ...bank, bankCode: '999999' }),
    ).rejects.toThrow(BadRequestException);
    expect(paystack.resolveAccount).toHaveBeenCalledTimes(1);
  });

  it('is unavailable (503) when there is no bank list at all', async () => {
    banks.list.mockRejectedValue(new BadGatewayException('no list'));
    await expect(service.resolve(bank)).rejects.toThrow(
      new ServiceUnavailableException(ACCOUNT_LOOKUP_UNAVAILABLE),
    );
    expect(paystack.resolveAccount).not.toHaveBeenCalled();
  });

  it('maps unresolvable to 422 and unavailable to 503', async () => {
    paystack.resolveAccount.mockResolvedValueOnce({ status: 'unresolvable' });
    const notFound = await service.resolve(momo).catch((e: unknown) => e);
    expect(notFound).toBeInstanceOf(UnprocessableEntityException);
    expect((notFound as Error).message).toBe(ACCOUNT_NAME_NOT_FOUND);

    paystack.resolveAccount.mockResolvedValueOnce({ status: 'unavailable' });
    const down = await service.resolve(momo).catch((e: unknown) => e);
    expect(down).toBeInstanceOf(ServiceUnavailableException);
    expect((down as Error).message).toBe(ACCOUNT_LOOKUP_UNAVAILABLE);
  });
});
