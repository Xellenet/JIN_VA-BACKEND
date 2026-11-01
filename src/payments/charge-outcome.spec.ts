import { CHARGE_MESSAGES, mapChargeReply } from './charge-outcome';

const ok = (data: Record<string, unknown>) =>
  ({ outcome: 'ok', data }) as const;

describe('mapChargeReply', () => {
  it.each(['pay_offline', 'pending', 'ongoing', 'something_new'])(
    'mobile money %s → approve on your phone',
    (status) => {
      expect(mapChargeReply(ok({ status }), 'mobile_money')).toEqual({
        status: 'pending',
        action: 'approve_on_phone',
        message: CHARGE_MESSAGES.APPROVE_ON_PHONE,
      });
    },
  );

  it('card pending → wait', () => {
    expect(mapChargeReply(ok({ status: 'pending' }), 'card')).toEqual({
      status: 'pending',
      action: 'wait',
      message: CHARGE_MESSAGES.CONFIRMING,
    });
  });

  it('success is still pending: only the webhook moves the payment', () => {
    for (const m of ['mobile_money', 'card'] as const) {
      expect(mapChargeReply(ok({ status: 'success' }), m)).toMatchObject({
        status: 'pending',
        action: 'wait',
      });
    }
  });

  it('Telecel send_otp → needs_otp; a card OTP goes to the hosted checkout', () => {
    expect(
      mapChargeReply(
        ok({ status: 'send_otp', display_text: 'x' }),
        'mobile_money',
      ),
    ).toEqual({
      status: 'needs_otp',
      action: 'enter_otp',
      message: CHARGE_MESSAGES.ENTER_OTP,
    });
    expect(mapChargeReply(ok({ status: 'send_otp' }), 'card')).toMatchObject({
      status: 'failed',
      action: 'pay_another_way',
    });
  });

  it.each([
    'send_pin',
    'send_phone',
    'send_birthday',
    'send_address',
    'open_url',
  ])('%s needs a step we never take here → pay another way', (status) => {
    expect(mapChargeReply(ok({ status }), 'card')).toEqual({
      status: 'failed',
      action: 'pay_another_way',
      message: CHARGE_MESSAGES.NEEDS_MORE,
    });
  });

  it('failed uses safe provider text, else a generic message', () => {
    expect(
      mapChargeReply(
        ok({ status: 'failed', display_text: 'Insufficient funds' }),
        'mobile_money',
      ),
    ).toEqual({
      status: 'failed',
      action: null,
      message: 'Insufficient funds',
    });
    expect(
      mapChargeReply(
        ok({ status: 'failed', gateway_response: 'Declined' }),
        'card',
      ).message,
    ).toBe('Declined');
    expect(
      mapChargeReply(
        ok({ status: 'failed', display_text: 'Error 5000123 at gw' }),
        'card',
      ).message,
    ).toBe(CHARGE_MESSAGES.FAILED);
    expect(
      mapChargeReply(ok({ status: 'failed' }), 'mobile_money', {
        otpStep: true,
      }).message,
    ).toBe(CHARGE_MESSAGES.OTP_FAILED);
  });

  it('a refusal is failed; on the OTP step it says the code did not work', () => {
    const refused = {
      outcome: 'refused',
      httpStatus: 400,
      message: 'Charge attempted',
    } as const;
    expect(mapChargeReply(refused, 'mobile_money')).toEqual({
      status: 'failed',
      action: null,
      message: 'Charge attempted',
    });
    expect(mapChargeReply({ ...refused, message: null }, 'card').message).toBe(
      CHARGE_MESSAGES.FAILED,
    );
    expect(
      mapChargeReply(refused, 'mobile_money', { otpStep: true }).message,
    ).toBe(CHARGE_MESSAGES.OTP_FAILED);
  });

  it('unreachable stays pending (the status check verifies later)', () => {
    const u = { outcome: 'unreachable' } as const;
    expect(mapChargeReply(u, 'mobile_money').action).toBe('approve_on_phone');
    expect(mapChargeReply(u, 'card').action).toBe('wait');
    expect(mapChargeReply(u, 'mobile_money', { otpStep: true })).toEqual({
      status: 'pending',
      action: 'wait',
      message: CHARGE_MESSAGES.CONFIRMING,
    });
  });

  it('a reply with no data is treated as waiting', () => {
    expect(
      mapChargeReply(
        { outcome: 'ok', data: undefined as never },
        'mobile_money',
      ).status,
    ).toBe('pending');
  });
});
