import { PREFERRED_CHANNELS } from './payment-settings.enums';

/**
 * B5c: the Paystack checkout channels the server allows, in their default
 * order. Fixed on the server; nothing about channels is accepted from a client
 * (SEC-14).
 */
export const PAYSTACK_CHECKOUT_CHANNELS: readonly string[] = Object.freeze([
  'card',
  'mobile_money',
  'bank',
  'bank_transfer',
  'ussd',
  'qr',
  'apple_pay',
]);

/**
 * The `channels` list to send Paystack for a customer's stored preference.
 *
 * - No preference, or anything not in the allowlist: `undefined`, so the
 *   Paystack payload carries no `channels` key and checkout behaves exactly
 *   as it did before payment settings existed.
 * - `mobile_money` or `card`: the full allowlist with that channel moved to
 *   the front. Nothing is ever dropped.
 */
export function orderCheckoutChannels(
  preferred: string | null | undefined,
): string[] | undefined {
  if (
    typeof preferred !== 'string' ||
    !(PREFERRED_CHANNELS as readonly string[]).includes(preferred) ||
    !PAYSTACK_CHECKOUT_CHANNELS.includes(preferred)
  ) {
    return undefined;
  }
  return [
    preferred,
    ...PAYSTACK_CHECKOUT_CHANNELS.filter((channel) => channel !== preferred),
  ];
}
