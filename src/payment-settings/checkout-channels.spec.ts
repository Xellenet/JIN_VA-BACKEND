import {
  orderCheckoutChannels,
  PAYSTACK_CHECKOUT_CHANNELS,
} from './checkout-channels';

describe('orderCheckoutChannels (BU-5.1)', () => {
  it('puts mobile money first and keeps every other allowed channel', () => {
    expect(orderCheckoutChannels('mobile_money')).toEqual([
      'mobile_money',
      'card',
      'bank',
      'bank_transfer',
      'ussd',
      'qr',
      'apple_pay',
    ]);
  });

  it('puts card first', () => {
    const channels = orderCheckoutChannels('card');
    expect(channels?.[0]).toBe('card');
    expect([...(channels ?? [])].sort()).toEqual(
      [...PAYSTACK_CHECKOUT_CHANNELS].sort(),
    );
  });

  it.each([null, undefined, '', 'bank', 'ussd', 'MOBILE_MONEY', 'bitcoin'])(
    'returns undefined for %p, so no channels key is sent',
    (value) => {
      expect(orderCheckoutChannels(value)).toBeUndefined();
    },
  );

  it('never lets a caller change the allowlist', () => {
    const channels = orderCheckoutChannels('card')!;
    channels.push('evil');
    expect(PAYSTACK_CHECKOUT_CHANNELS).not.toContain('evil');
    expect(Object.isFrozen(PAYSTACK_CHECKOUT_CHANNELS)).toBe(true);
  });
});
