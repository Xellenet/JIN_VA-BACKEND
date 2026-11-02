import { plainToInstance } from 'class-transformer';
import { PayoutType } from '@common/types/enums';
import {
  ArtisanProfileResponseDto,
  payoutDestinationOf,
} from './artisan-profile-response.dto';
import { BankListService, resetBankListCache } from '../../payments/bank-list';

describe('ArtisanProfileResponseDto payout destination', () => {
  afterEach(() => resetBankListCache());

  it('masks a mobile money number to the provider label and last 4', () => {
    const dto = plainToInstance(
      ArtisanProfileResponseDto,
      {
        id: 1,
        payoutType: PayoutType.MOBILE_MONEY,
        payoutAccountNumber: '0241231234',
        payoutAccountName: 'Yaw Osei',
        payoutBankCode: 'MTN',
        paystackRecipientCode: 'RCP_secret',
      },
      { excludeExtraneousValues: true },
    );
    expect(dto.payoutDestination).toEqual({
      type: 'mobile_money',
      label: 'MTN MoMo',
      last4: '1234',
      accountName: 'Yaw Osei',
      accountNameVerified: null,
    });
    expect(dto.payoutAccountNumber).toBe('••••••1234');
    expect(JSON.stringify(dto)).not.toContain('0241231234');
    expect(JSON.stringify(dto)).not.toContain('RCP_secret');
  });

  it.each([true, false])(
    'carries accountNameVerified %p next to the name',
    (verified) => {
      expect(
        payoutDestinationOf({
          payoutType: PayoutType.MOBILE_MONEY,
          payoutAccountNumber: '0240000000',
          payoutAccountName: 'KOFI ASANTE',
          payoutAccountNameVerified: verified,
          payoutBankCode: 'MTN',
        }),
      ).toMatchObject({
        accountName: 'KOFI ASANTE',
        accountNameVerified: verified,
      });
    },
  );

  it('is null when no payout method is set', () => {
    const dto = plainToInstance(
      ArtisanProfileResponseDto,
      { id: 1 },
      { excludeExtraneousValues: true },
    );
    expect(dto.payoutDestination).toBeNull();
  });

  it.each([
    ['VOD', 'Telecel Cash'],
    ['ATL', 'AirtelTigo Money'],
    ['XYZ', 'Mobile money'],
  ])('labels %s as %s', (code, label) => {
    expect(
      payoutDestinationOf({
        payoutType: PayoutType.MOBILE_MONEY,
        payoutAccountNumber: '0201234567',
        payoutBankCode: code,
      })?.label,
    ).toBe(label);
  });

  it('names a bank from the cached list, else "Bank account"', async () => {
    const profile = {
      payoutType: PayoutType.BANK,
      payoutAccountNumber: '1234567890123',
      payoutBankCode: '280100',
      payoutAccountName: ' ',
    };
    expect(payoutDestinationOf(profile)).toEqual({
      type: 'bank',
      label: 'Bank account',
      last4: '0123',
      accountName: null,
      accountNameVerified: null,
    });
    const paystack = {
      listBanks: jest
        .fn()
        .mockResolvedValue([
          { code: '280100', name: 'Access Bank', type: 'ghipss' },
        ]),
    };
    await new BankListService(paystack as never).list();
    expect(payoutDestinationOf(profile)?.label).toBe('Access Bank');
  });
});
