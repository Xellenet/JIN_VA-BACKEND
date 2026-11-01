import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  isValidPayoutAccountNumber,
  isValidPayoutBankCode,
  normalisePayoutAccountNumber,
  normalisePayoutBankCode,
} from './payout-account';
import { ResolvePayoutAccountDto } from './dto/resolve-payout-account.dto';
import { SetupPayoutMethodDto } from './dto/setup-payout-method.dto';

describe('payout account rules', () => {
  it.each([
    ['0240000000', '0240000000'],
    ['024 000 0000', '0240000000'],
    ['024-000-0000', '0240000000'],
    ['+233240000000', '0240000000'],
    ['233240000000', '0240000000'],
    ['00233240000000', '0240000000'],
    ['+2330240000000', '0240000000'],
    ['+2331240000000', '+2331240000000'],
    ['+44240000000', '+44240000000'],
  ])('normalises mobile money %p to %p', (raw, expected) => {
    expect(normalisePayoutAccountNumber('mobile_money', raw)).toBe(expected);
  });

  it('only strips separators from a bank number, and passes non-strings through', () => {
    expect(normalisePayoutAccountNumber('bank', ' 1234 5678 ')).toBe(
      '12345678',
    );
    expect(normalisePayoutAccountNumber('bank', '233240000000')).toBe(
      '233240000000',
    );
    expect(normalisePayoutAccountNumber('mobile_money', 42)).toBe(42);
  });

  it.each([
    ['mobile_money', '0240000000', true],
    ['mobile_money', '240000000', false],
    ['mobile_money', '02400000001', false],
    ['mobile_money', '1240000000', false],
    ['bank', '123456', true],
    ['bank', '12345678901234567890', true],
    ['bank', '12345', false],
    ['bank', '123456789012345678901', false],
    ['bank', '12345a', false],
    ['other', '0240000000', false],
    ['bank', 123456, false],
  ])('%s number %p is valid: %p', (type, value, expected) => {
    expect(isValidPayoutAccountNumber(type, value)).toBe(expected);
  });

  it.each([
    ['mobile_money', 'MTN', true],
    ['mobile_money', 'VOD', true],
    ['mobile_money', 'ATL', true],
    ['mobile_money', '280100', false],
    ['bank', '280100', true],
    ['bank', 'GH010100', true],
    ['bank', 'GH 01', false],
    ['bank', 'x', false],
    ['other', 'MTN', false],
    ['bank', null, false],
  ])('%s code %p is valid: %p', (type, value, expected) => {
    expect(isValidPayoutBankCode(type, value)).toBe(expected);
  });

  it('upper-cases a mobile money code and trims a bank code', () => {
    expect(normalisePayoutBankCode('mobile_money', ' vod ')).toBe('VOD');
    expect(normalisePayoutBankCode('bank', ' gh010100 ')).toBe('gh010100');
    expect(normalisePayoutBankCode('bank', 7)).toBe(7);
  });
});

describe('payout DTOs', () => {
  const check = <T extends object>(cls: new () => T, plain: object) => {
    const dto = plainToInstance(cls, plain);
    return { dto, errors: validateSync(dto, { whitelist: true }) };
  };

  it('normalises and accepts a +233 mobile money number and a lower-case network', () => {
    const { dto, errors } = check(ResolvePayoutAccountDto, {
      type: 'mobile_money',
      accountNumber: '+233 24 000 0000',
      bankCode: 'mtn',
    });
    expect(errors).toEqual([]);
    expect(dto).toMatchObject({ accountNumber: '0240000000', bankCode: 'MTN' });
  });

  it('rejects a short number, a bank code for mobile money and a bad type', () => {
    const momo = check(ResolvePayoutAccountDto, {
      type: 'mobile_money',
      accountNumber: '024000',
      bankCode: '280100',
    }).errors.map((e) => e.property);
    expect(momo).toEqual(['accountNumber', 'bankCode']);

    const bank = check(ResolvePayoutAccountDto, {
      type: 'bank',
      accountNumber: '12345',
      bankCode: 'GH 01',
    }).errors;
    expect(bank.map((e) => e.property)).toEqual(['accountNumber', 'bankCode']);
    expect(Object.values(bank[0].constraints ?? {})).toContain(
      'Enter the bank account number using digits only (6 to 20 digits).',
    );

    const type = check(ResolvePayoutAccountDto, {
      type: 'card',
      accountNumber: '0240000000',
      bankCode: 'MTN',
    }).errors.map((e) => e.property);
    expect(type).toEqual(['type', 'accountNumber', 'bankCode']);
  });

  it('makes accountName optional on save, treats blank as absent, still checks a typed one', () => {
    const base = {
      type: 'bank',
      accountNumber: '1234567890',
      bankCode: '280100',
    };
    expect(check(SetupPayoutMethodDto, base).errors).toEqual([]);
    const blank = check(SetupPayoutMethodDto, { ...base, accountName: '   ' });
    expect(blank.errors).toEqual([]);
    expect(blank.dto.accountName).toBeUndefined();
    const typed = check(SetupPayoutMethodDto, {
      ...base,
      accountName: '  Kofi   Asante ',
    });
    expect(typed.dto.accountName).toBe('Kofi Asante');
    expect(
      check(SetupPayoutMethodDto, { ...base, accountName: 'K' }).errors.map(
        (e) => e.property,
      ),
    ).toEqual(['accountName']);
    expect(
      check(SetupPayoutMethodDto, { ...base, accountName: 5 }).errors.map(
        (e) => e.property,
      ),
    ).toEqual(['accountName']);
  });
});
