import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { Payment } from '../payments/entities/payment.entity';
import { PaymentStatus } from '@common/types/enums';
import type { CustomerBucket } from './customer-range';

/**
 * Customer experience v2: the **one** definition of customer spend (Q3, the
 * implementation plan's "Spend rules"). The Overview rail (B6) and the
 * Spending report (B2) both read their figures through `SpendService`, so the
 * two pages cannot disagree (BU-2.5, E-2.7, E-4.19).
 *
 * - Counted: HELD, PENDING_TRANSFER, TRANSFER_FAILED, RELEASED, REFUNDED.
 * - Held: the first three (paid, not yet released to the artisan).
 * - net = amount − refunded_amount; a refund reduces the bucket the payment
 *   was **paid** in.
 * - A payment is dated by COALESCE(paid_at, created_at), in Africa/Accra.
 * - PENDING, FAILED and CANCELLED never count (they appear in the history only).
 */
export const COUNTED_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.HELD,
  PaymentStatus.PENDING_TRANSFER,
  PaymentStatus.TRANSFER_FAILED,
  PaymentStatus.RELEASED,
  PaymentStatus.REFUNDED,
];

export const HELD_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.HELD,
  PaymentStatus.PENDING_TRANSFER,
  PaymentStatus.TRANSFER_FAILED,
];

/** SQL: the instant a payment is dated by (alias `p`). */
export const PAYMENT_DATE_SQL = 'COALESCE(p.paid_at, p.created_at)';

/** SQL: a payment's net amount (alias `p`). */
export const PAYMENT_NET_SQL = '(p.amount - COALESCE(p.refunded_amount, 0))';

/** SQL: the payment date as an Accra wall-clock timestamp. */
export const PAYMENT_LOCAL_DATE_SQL = `(${PAYMENT_DATE_SQL} AT TIME ZONE 'Africa/Accra')`;

export const CUSTOMER_CURRENCY = 'GHS';

/**
 * Money arrives from Postgres as a numeric string (`"1500.00"`, `"0"`) or, in
 * tests, as a number. Everything is converted to integer pesewas once, summed
 * as integers and only turned back into a string at the edge, so no float
 * artefact (`0.30000000000000004`) can reach a response (BU-2.8).
 */
export function toCents(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Integer pesewas → a money string with exactly two decimals. */
export function centsToMoney(cents: number): string {
  const c = Math.round(cents);
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Any money value → a money string with exactly two decimals. */
export function moneyString(value: unknown): string {
  return centsToMoney(toCents(value));
}

/** `part / total` rounded to 3 decimals; 0 when the total is 0. */
export function shareOf(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 1000;
}

/** B2/B3 method groups: `bank_transfer` is bank; null or unknown is `other`. */
export type ChannelGroup = 'mobile_money' | 'card' | 'bank' | 'other';

export function channelGroup(channel: string | null | undefined): ChannelGroup {
  switch ((channel ?? '').toLowerCase()) {
    case 'mobile_money':
      return 'mobile_money';
    case 'card':
      return 'card';
    case 'bank':
    case 'bank_transfer':
      return 'bank';
    default:
      return 'other';
  }
}

export interface BucketNet {
  cents: number;
  count: number;
}

export interface SpendTotalsCents {
  grossCents: number;
  refundedCents: number;
  netCents: number;
  releasedCents: number;
  count: number;
}

/**
 * The SQL half of the spend rules. Every query starts from `counted()`, which
 * scopes to `customer_id = :me` with a bound parameter, so no figure can ever
 * include another customer's payment (SEC-1).
 */
@Injectable()
export class SpendService {
  constructor(
    @InjectRepository(Payment)
    private readonly payments: Repository<Payment>,
  ) {}

  /** The caller's counted payments, optionally narrowed to `[from, to]`. */
  counted(
    me: number,
    from?: Date | null,
    to?: Date | null,
    { endExclusive = false }: { endExclusive?: boolean } = {},
  ): SelectQueryBuilder<Payment> {
    const qb = this.payments
      .createQueryBuilder('p')
      .where('p.customer_id = :me', { me })
      .andWhere('p.status IN (:...countedStatuses)', {
        countedStatuses: COUNTED_STATUSES,
      });
    if (from)
      qb.andWhere(`${PAYMENT_DATE_SQL} >= :windowFrom`, { windowFrom: from });
    if (to) {
      qb.andWhere(
        `${PAYMENT_DATE_SQL} ${endExclusive ? '<' : '<='} :windowTo`,
        { windowTo: to },
      );
    }
    return qb;
  }

  /** True when the caller has any counted payment, ever. */
  async hasPaymentsEver(me: number): Promise<boolean> {
    const row = await this.counted(me)
      .select('p.id', 'id')
      .limit(1)
      .getRawOne<{ id: number }>();
    return !!row;
  }

  /** Net of every payment currently held, of any date. */
  async heldCents(me: number): Promise<number> {
    const row = await this.payments
      .createQueryBuilder('p')
      .select(`COALESCE(SUM(${PAYMENT_NET_SQL}), 0)`, 'held')
      .where('p.customer_id = :me', { me })
      .andWhere('p.status IN (:...heldStatuses)', {
        heldStatuses: HELD_STATUSES,
      })
      .getRawOne<{ held: string }>();
    return toCents(row?.held);
  }

  /** Date of the caller's first counted payment, or null. */
  async firstPaymentDate(me: number): Promise<Date | null> {
    const row = await this.counted(me)
      .select(`MIN(${PAYMENT_DATE_SQL})`, 'first')
      .getRawOne<{ first: Date | string | null }>();
    return row?.first ? new Date(row.first) : null;
  }

  /**
   * Net spent and payment count per bucket start (`YYYY-MM-DD`, Accra).
   * Weeks are ISO weeks (Monday), as Postgres `date_trunc('week')` gives.
   */
  async netByBucket(
    me: number,
    bucket: CustomerBucket,
    from: Date | null,
    to: Date,
  ): Promise<Map<string, BucketNet>> {
    const rows = await this.counted(me, from, to)
      .select(
        `to_char(date_trunc(:bucketUnit, ${PAYMENT_LOCAL_DATE_SQL}), 'YYYY-MM-DD')`,
        'bucket',
      )
      .addSelect(`COALESCE(SUM(${PAYMENT_NET_SQL}), 0)`, 'net')
      .addSelect('COUNT(*)', 'count')
      .setParameter('bucketUnit', bucket)
      .groupBy('bucket')
      .getRawMany<{ bucket: string; net: string; count: string }>();
    return new Map(
      rows.map((r) => [
        r.bucket,
        { cents: toCents(r.net), count: Number(r.count) },
      ]),
    );
  }

  /** Gross, refunded, net, released and count over a window. */
  async totals(
    me: number,
    from: Date | null,
    to: Date,
  ): Promise<SpendTotalsCents> {
    const row = await this.counted(me, from, to)
      .select('COALESCE(SUM(p.amount), 0)', 'gross')
      .addSelect('COALESCE(SUM(COALESCE(p.refunded_amount, 0)), 0)', 'refunded')
      .addSelect(
        `COALESCE(SUM(CASE WHEN p.status = :releasedStatus THEN ${PAYMENT_NET_SQL} ELSE 0 END), 0)`,
        'released',
      )
      .addSelect('COUNT(*)', 'count')
      .setParameter('releasedStatus', PaymentStatus.RELEASED)
      .getRawOne<{
        gross: string;
        refunded: string;
        released: string;
        count: string;
      }>();
    const grossCents = toCents(row?.gross);
    const refundedCents = toCents(row?.refunded);
    return {
      grossCents,
      refundedCents,
      netCents: grossCents - refundedCents,
      releasedCents: toCents(row?.released),
      count: Number(row?.count ?? 0),
    };
  }

  /** Net spent in `[from, to)` (used for the previous period). */
  async netCentsBetween(me: number, from: Date, to: Date): Promise<number> {
    const row = await this.counted(me, from, to, { endExclusive: true })
      .select(`COALESCE(SUM(${PAYMENT_NET_SQL}), 0)`, 'net')
      .getRawOne<{ net: string }>();
    return toCents(row?.net);
  }
}
