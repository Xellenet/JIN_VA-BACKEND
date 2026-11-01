import type { PaystackChargeReply } from './paystack.service';
import { safeProviderText } from '../payment-methods/payment-methods.constants';

/** What the customer does next (the API's `action`). */
export type ChargeAction =
  | 'approve_on_phone'
  | 'enter_otp'
  | 'wait'
  | 'pay_another_way';

/** The charge state the API reports. */
export type ChargeApiStatus = 'pending' | 'needs_otp' | 'succeeded' | 'failed';

export interface ChargeOutcome {
  status: 'pending' | 'needs_otp' | 'failed';
  action: ChargeAction | null;
  message: string | null;
}

export const CHARGE_MESSAGES = {
  APPROVE_ON_PHONE:
    'Check your phone and approve the payment with your MoMo PIN.',
  CONFIRMING: "We're confirming your payment.",
  ENTER_OTP:
    'Enter the one-time code Telecel sent you by text. It is not your PIN.',
  NEEDS_MORE:
    "This payment needs a step we can't do here. Pay another way to finish.",
  FAILED:
    "The payment didn't go through. You can try again or pay another way.",
  OTP_FAILED:
    "That code didn't work. Try again to get a new code, or pay another way.",
  NOT_APPROVED:
    "This payment wasn't approved. You can try again or pay another way.",
  DUPLICATE:
    'This job is already paid. Our team will review the extra payment.',
} as const;

/** Paystack statuses that need a step only the hosted checkout can take. */
const NEEDS_HOSTED = new Set([
  'send_pin',
  'send_phone',
  'send_birthday',
  'send_address',
  'open_url',
]);

/**
 * Maps a Paystack direct-charge reply to what we tell the customer. Never
 * returns raw provider text unless `safeProviderText` accepts it.
 *
 * - `pay_offline` / `pending` / `ongoing`: mobile money waits for the
 *   customer's approval on their phone; a card waits for confirmation.
 * - `send_otp`: mobile money (Telecel) asks for the one-time code; a card
 *   OTP (from a bank) is sent to the hosted checkout instead.
 * - `success`: still pending here; only the webhook (or a verify) moves the
 *   payment to HELD.
 * - `failed`, or a refusal: failed, with the provider's text when safe.
 * - Unreachable: pending; the status endpoint verifies later.
 */
export function mapChargeReply(
  reply: PaystackChargeReply,
  method: 'mobile_money' | 'card',
  opts: { otpStep?: boolean } = {},
): ChargeOutcome {
  const momo = method === 'mobile_money';
  const waiting = (): ChargeOutcome =>
    momo
      ? {
          status: 'pending',
          action: 'approve_on_phone',
          message: CHARGE_MESSAGES.APPROVE_ON_PHONE,
        }
      : {
          status: 'pending',
          action: 'wait',
          message: CHARGE_MESSAGES.CONFIRMING,
        };

  if (reply.outcome === 'unreachable') {
    return opts.otpStep
      ? {
          status: 'pending',
          action: 'wait',
          message: CHARGE_MESSAGES.CONFIRMING,
        }
      : waiting();
  }
  if (reply.outcome === 'refused') {
    return {
      status: 'failed',
      action: null,
      message: opts.otpStep
        ? CHARGE_MESSAGES.OTP_FAILED
        : (safeProviderText(reply.message) ?? CHARGE_MESSAGES.FAILED),
    };
  }

  const data = reply.data ?? {};
  const status = typeof data.status === 'string' ? data.status : '';
  switch (status) {
    case 'success':
      return {
        status: 'pending',
        action: 'wait',
        message: CHARGE_MESSAGES.CONFIRMING,
      };
    case 'pay_offline':
    case 'pending':
    case 'ongoing':
      return waiting();
    case 'send_otp':
      if (!momo) {
        return {
          status: 'failed',
          action: 'pay_another_way',
          message: CHARGE_MESSAGES.NEEDS_MORE,
        };
      }
      return {
        status: 'needs_otp',
        action: 'enter_otp',
        message: CHARGE_MESSAGES.ENTER_OTP,
      };
    case 'failed':
    case 'abandoned':
    case 'reversed':
      return {
        status: 'failed',
        action: null,
        message:
          safeProviderText(data.display_text) ??
          safeProviderText(data.gateway_response) ??
          (opts.otpStep ? CHARGE_MESSAGES.OTP_FAILED : CHARGE_MESSAGES.FAILED),
      };
    default:
      if (NEEDS_HOSTED.has(status)) {
        return {
          status: 'failed',
          action: 'pay_another_way',
          message: CHARGE_MESSAGES.NEEDS_MORE,
        };
      }
      return waiting();
  }
}
