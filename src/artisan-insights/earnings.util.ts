import { NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { PaymentStatus } from '@common/types/enums';
import type { Payment } from '../payments/entities/payment.entity';
import type { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { centsToMoney, toCents } from '../customer-insights/spend.util';
import { startOfMonth } from '../customer-insights/customer-range';

/**
 * Artisan fixes (B1, B2): the **one** definition of an artisan's earnings, so
 * the Overview line and the Earnings statement can never disagree.
 *
 * - Money is the artisan's payout (`artisan_amount`), unless a field says
 *   gross (`amount`) or fee (`platform_fee`).
 * - A payment is dated by COALESCE(released_at, paid_at, created_at) — the
 *   "earning date".
 * - Counted (gross/fee/net totals and months): held, on the way, needs
 *   action, paid. Refunded, unpaid and cancelled payments never count.
 */
export const EARNING_STAGES = [
  'awaiting_payment',
  'held',
  'on_the_way',
  'needs_action',
  'paid',
  'refunded',
  'not_paid',
] as const;
export type EarningStage = (typeof EARNING_STAGES)[number];

export const COUNTED_STAGES: readonly EarningStage[] = [
  'held',
  'on_the_way',
  'needs_action',
  'paid',
];

export type FailureReason = 'no_payout_method' | 'transfer_failed';

export const ARTISAN_CURRENCY = 'GHS';

/** SQL: the instant a payment is dated by (alias `p`). */
export const EARNING_DATE_SQL =
  'COALESCE(p.released_at, p.paid_at, p.created_at)';

/**
 * SQL: the stage of a payment (alias `p`). Only enum constants are inlined,
 * never request input.
 */
export const STAGE_SQL = `(CASE
  WHEN p.status = '${PaymentStatus.PENDING}' THEN 'awaiting_payment'
  WHEN p.status = '${PaymentStatus.HELD}' AND p.transfer_code IS NOT NULL THEN 'on_the_way'
  WHEN p.status = '${PaymentStatus.HELD}' THEN 'held'
  WHEN p.status IN ('${PaymentStatus.PENDING_TRANSFER}', '${PaymentStatus.TRANSFER_FAILED}') THEN 'needs_action'
  WHEN p.status = '${PaymentStatus.RELEASED}' THEN 'paid'
  WHEN p.status = '${PaymentStatus.REFUNDED}' THEN 'refunded'
  ELSE 'not_paid' END)`;

/** SQL: true for a counted payment (alias `p`). */
export const COUNTED_SQL = `p.status IN ('${PaymentStatus.HELD}', '${PaymentStatus.PENDING_TRANSFER}', '${PaymentStatus.TRANSFER_FAILED}', '${PaymentStatus.RELEASED}')`;

/** The stage of one payment, mirroring `STAGE_SQL`. */
export function stageOf(
  status: PaymentStatus | string,
  transferStarted: boolean,
): EarningStage {
  switch (status as PaymentStatus) {
    case PaymentStatus.PENDING:
      return 'awaiting_payment';
    case PaymentStatus.HELD:
      return transferStarted ? 'on_the_way' : 'held';
    case PaymentStatus.PENDING_TRANSFER:
    case PaymentStatus.TRANSFER_FAILED:
      return 'needs_action';
    case PaymentStatus.RELEASED:
      return 'paid';
    case PaymentStatus.REFUNDED:
      return 'refunded';
    default:
      return 'not_paid';
  }
}

/** Why money needs the artisan's action; `null` otherwise. */
export function failureReasonOf(
  status: PaymentStatus | string,
): FailureReason | null {
  const s = status as PaymentStatus;
  if (s === PaymentStatus.PENDING_TRANSFER) return 'no_payout_method';
  if (s === PaymentStatus.TRANSFER_FAILED) return 'transfer_failed';
  return null;
}

/** Stages where the artisan has, or will get, a payout. */
export function hasPayout(stage: EarningStage): boolean {
  return (COUNTED_STAGES as readonly string[]).includes(stage);
}

export const FORMER_CLIENT = 'Former client';

/** The client's display name; never more than first and last name. */
export function clientName(row: {
  clientFirstname: string | null;
  clientLastname: string | null;
  clientGone: boolean | null;
}): string {
  if (row.clientGone) return FORMER_CLIENT;
  const name =
    `${row.clientFirstname ?? ''} ${row.clientLastname ?? ''}`.trim();
  return name || FORMER_CLIENT;
}

/** SQL: whether the client account behind alias `c` is gone. */
export const CLIENT_GONE_SQL =
  '(c.id IS NULL OR c.deleted_at IS NOT NULL OR c.purged_at IS NOT NULL)';

/**
 * The caller's artisan profile id, looked up by the JWT subject. 404 when the
 * user has no artisan profile.
 */
export async function resolveArtisanProfileId(
  profiles: Repository<ArtisanProfile>,
  me: number,
): Promise<number> {
  const row = await profiles
    .createQueryBuilder('ap')
    .select('ap.id', 'id')
    .where('ap.user_id = :me', { me })
    .getRawOne<{ id: number | string }>();
  if (!row) throw new NotFoundException('Artisan profile not found.');
  return Number(row.id);
}

export interface EarningBalances {
  heldForSignOff: string;
  onTheWay: string;
  needsAction: string;
  needsActionCount: number;
  paidThisMonth: string;
}

interface BalanceRow {
  held: string | number | null;
  onTheWay: string | number | null;
  needsAction: string | number | null;
  needsActionCount: string | number | null;
  paidThisMonth: string | number | null;
}

/**
 * Money right now (not limited by a period): held for sign-off, on its way,
 * needing action, and paid this calendar month (Accra = UTC).
 */
export async function queryBalances(
  payments: Repository<Payment>,
  artisanProfileId: number,
  now: Date,
): Promise<EarningBalances> {
  const row = await payments
    .createQueryBuilder('p')
    .select(
      `COALESCE(SUM(p.artisan_amount) FILTER (WHERE p.status = '${PaymentStatus.HELD}' AND p.transfer_code IS NULL), 0)`,
      'held',
    )
    .addSelect(
      `COALESCE(SUM(p.artisan_amount) FILTER (WHERE p.status = '${PaymentStatus.HELD}' AND p.transfer_code IS NOT NULL), 0)`,
      'onTheWay',
    )
    .addSelect(
      `COALESCE(SUM(p.artisan_amount) FILTER (WHERE p.status IN ('${PaymentStatus.PENDING_TRANSFER}', '${PaymentStatus.TRANSFER_FAILED}')), 0)`,
      'needsAction',
    )
    .addSelect(
      `COUNT(*) FILTER (WHERE p.status IN ('${PaymentStatus.PENDING_TRANSFER}', '${PaymentStatus.TRANSFER_FAILED}'))`,
      'needsActionCount',
    )
    .addSelect(
      `COALESCE(SUM(p.artisan_amount) FILTER (WHERE p.status = '${PaymentStatus.RELEASED}' AND p.released_at >= :monthStart), 0)`,
      'paidThisMonth',
    )
    .where('p.artisan_profile_id = :artisanProfileId', { artisanProfileId })
    .setParameter('monthStart', startOfMonth(now))
    .getRawOne<BalanceRow>();
  return {
    heldForSignOff: centsToMoney(toCents(row?.held)),
    onTheWay: centsToMoney(toCents(row?.onTheWay)),
    needsAction: centsToMoney(toCents(row?.needsAction)),
    needsActionCount: Number(row?.needsActionCount ?? 0),
    paidThisMonth: centsToMoney(toCents(row?.paidThisMonth)),
  };
}
