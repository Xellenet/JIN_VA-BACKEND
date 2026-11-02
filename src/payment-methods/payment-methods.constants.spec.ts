import {
  findPinLikeKeys,
  isCardExpired,
  isGhanaMobileNumber,
  isPinLikeKey,
  maskMobileNumber,
  normaliseCardBrand,
  safeProviderText,
} from './payment-methods.constants';

describe('saved payment method rules', () => {
  it.each([
    ['0240000000', true],
    ['0200000000', true],
    ['0570000000', true],
    ['0300000000', false], // a landline
    ['024000000', false],
    ['+233240000000', false], // normalised before this check
    [240000000, false],
  ])('isGhanaMobileNumber(%p) is %p', (value, ok) => {
    expect(isGhanaMobileNumber(value)).toBe(ok);
  });

  it('masks to the prefix and last four only', () => {
    expect(maskMobileNumber('024', '4567')).toBe('024 ••• 4567');
    expect(maskMobileNumber(null, null)).toBe('0•• ••• ••••');
  });

  it.each([
    'pin',
    'PIN',
    'momoPin',
    'momo_pin',
    'pinCode',
    'pin-number',
    'walletPIN',
    'mobile_money_pin',
  ])('treats %s as a PIN field', (key) => {
    expect(isPinLikeKey(key)).toBe(true);
  });

  it.each(['otp', 'network', 'accountNumber', 'paymentMethodId', 'spine?'])(
    'does not treat %s as a PIN field',
    (key) => {
      expect(isPinLikeKey(key)).toBe(false);
    },
  );

  it('finds PIN fields at any depth, in objects and arrays', () => {
    expect(findPinLikeKeys({ network: 'MTN' })).toEqual([]);
    expect(findPinLikeKeys({ a: { b: [{ momo_pin: '1' }] } })).toEqual([
      'momo_pin',
    ]);
    expect(findPinLikeKeys(['pin'])).toEqual([]);
    expect(findPinLikeKeys(null)).toEqual([]);
    expect(findPinLikeKeys('pin')).toEqual([]);
  });

  it('keeps short, plain provider text and drops anything that could leak', () => {
    expect(safeProviderText('Insufficient funds')).toBe('Insufficient funds');
    expect(safeProviderText('  Declined  ')).toBe('Declined');
    expect(safeProviderText('Ref 123456789 failed')).toBeNull();
    expect(safeProviderText('Error: ECONNRESET')).toBeNull();
    expect(safeProviderText('<b>x</b>')).toBeNull();
    expect(safeProviderText('a'.repeat(200))).toBeNull();
    expect(safeProviderText('')).toBeNull();
    expect(safeProviderText(42)).toBeNull();
  });

  it('knows when a card has expired (end of the expiry month)', () => {
    const now = new Date(Date.UTC(2026, 10, 1)); // 1 Nov 2026
    expect(isCardExpired(10, 2026, now)).toBe(true);
    expect(isCardExpired(11, 2026, now)).toBe(false);
    expect(isCardExpired(12, 27, now)).toBe(false);
    expect(isCardExpired(null, 2026, now)).toBe(false);
  });

  it('normalises the card brand', () => {
    expect(normaliseCardBrand('visa ')).toBe('visa');
    expect(normaliseCardBrand('MasterCard')).toBe('mastercard');
    expect(normaliseCardBrand(undefined)).toBe('card');
    expect(normaliseCardBrand('  ')).toBe('card');
  });
});
