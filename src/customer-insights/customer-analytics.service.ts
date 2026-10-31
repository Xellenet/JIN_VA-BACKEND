import { Injectable } from '@nestjs/common';
import { TtlCache } from './customer-cache';
import {
  CustomerBucket,
  CustomerSpendRange,
  monthBucketsBetween,
  resolveCustomerWindow,
} from './customer-range';
import { artisanRef } from './customer-overview.service';
import {
  centsToMoney,
  ChannelGroup,
  channelGroup,
  CUSTOMER_CURRENCY,
  PAYMENT_DATE_SQL,
  PAYMENT_NET_SQL,
  shareOf,
  SpendService,
  toCents,
} from './spend.util';

/** B2: the number of named categories before the rest become "Other". */
export const TOP_CATEGORIES = 6;
/** B2: the most artisans returned (the page shows 5 and "Show all"). */
export const MAX_ARTISANS = 50;

export interface CustomerSpendingAnalytics {
  range: CustomerSpendRange;
  bucket: CustomerBucket;
  currency: string;
  period: { from: string | null; to: string };
  hasPaymentsEver: boolean;
  totals: {
    netSpent: string;
    grossPaid: string;
    refunded: string;
    held: string;
    released: string;
    paymentsCount: number;
    avgPayment: string;
    previousPeriodNetSpent: string | null;
  };
  series: Array<{ bucketStart: string; netSpent: string; count: number }>;
  byCategory: Array<{
    serviceId: number | null;
    serviceName: string;
    netSpent: string;
    count: number;
    share: number;
  }>;
  byArtisan: Array<{
    artisanProfileId: number | null;
    displayName: string;
    avatar: string | null;
    netSpent: string;
    count: number;
    lastPaidAt: string;
  }>;
  byChannel: Array<{
    channel: ChannelGroup;
    netSpent: string;
    count: number;
    share: number;
  }>;
  largestPayment: {
    id: number;
    jobId: number;
    jobTitle: string | null;
    amount: string;
    paidAt: string;
  } | null;
}

export interface CategoryRow {
  serviceId: number | string | null;
  serviceName: string | null;
  net: string | number;
  count: string | number;
}

export interface ArtisanRow {
  artisanProfileId: number | string | null;
  businessName: string | null;
  firstname: string | null;
  lastname: string | null;
  avatar: string | null;
  artisanGone: boolean | null;
  net: string | number;
  jobs: string | number;
  lastPaidAt: Date | string;
}

export interface ChannelRow {
  channel: string | null;
  net: string | number;
  count: string | number;
}

export interface LargestRow {
  id: number | string;
  jobId: number | string;
  jobTitle: string | null;
  amount: string | number;
  paidAt: Date | string;
}

const iso = (d: Date | string): string => new Date(d).toISOString();

/** Top `TOP_CATEGORIES` by net, then one "Other" holding the rest. */
export function mapCategories(
  rows: CategoryRow[],
  totalCents: number,
): CustomerSpendingAnalytics['byCategory'] {
  const items = rows
    .map((r) => ({
      serviceId: r.serviceId == null ? null : Number(r.serviceId),
      serviceName: r.serviceName ?? 'Other',
      cents: toCents(r.net),
      count: Number(r.count),
    }))
    .sort(
      (a, b) => b.cents - a.cents || a.serviceName.localeCompare(b.serviceName),
    );
  const top = items.slice(0, TOP_CATEGORIES);
  const rest = items.slice(TOP_CATEGORIES);
  if (rest.length) {
    top.push({
      serviceId: null,
      serviceName: 'Other',
      cents: rest.reduce((s, r) => s + r.cents, 0),
      count: rest.reduce((s, r) => s + r.count, 0),
    });
  }
  return top.map((r) => ({
    serviceId: r.serviceId,
    serviceName: r.serviceName,
    netSpent: centsToMoney(r.cents),
    count: r.count,
    share: shareOf(r.cents, totalCents),
  }));
}

/** Up to `MAX_ARTISANS`; a deleted artisan is "Former artisan" with no link. */
export function mapArtisans(
  rows: ArtisanRow[],
): CustomerSpendingAnalytics['byArtisan'] {
  return rows
    .map((r) => {
      const ref = artisanRef(r);
      return {
        artisanProfileId: ref.id,
        displayName: ref.displayName,
        avatar: ref.avatar,
        cents: toCents(r.net),
        count: Number(r.jobs),
        lastPaidAt: iso(r.lastPaidAt),
      };
    })
    .sort(
      (a, b) => b.cents - a.cents || b.lastPaidAt.localeCompare(a.lastPaidAt),
    )
    .slice(0, MAX_ARTISANS)
    .map((r) => ({
      artisanProfileId: r.artisanProfileId,
      displayName: r.displayName,
      avatar: r.avatar,
      netSpent: centsToMoney(r.cents),
      count: r.count,
      lastPaidAt: r.lastPaidAt,
    }));
}

/** Raw channels folded into mobile_money / card / bank / other. */
export function mapChannels(
  rows: ChannelRow[],
  totalCents: number,
): CustomerSpendingAnalytics['byChannel'] {
  const groups = new Map<ChannelGroup, { cents: number; count: number }>();
  for (const r of rows) {
    const g = channelGroup(r.channel);
    const acc = groups.get(g) ?? { cents: 0, count: 0 };
    acc.cents += toCents(r.net);
    acc.count += Number(r.count);
    groups.set(g, acc);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].cents - a[1].cents || a[0].localeCompare(b[0]))
    .map(([channel, v]) => ({
      channel,
      netSpent: centsToMoney(v.cents),
      count: v.count,
      share: shareOf(v.cents, totalCents),
    }));
}

/**
 * Customer experience v2 (B2): the Spending report for the caller only.
 *
 * Every aggregate is its own query scoped to `p.customer_id = :me` (SEC-1).
 * The totals and the time series come from `SpendService`, shared with the
 * Overview rail. Cached per user and range for 60 s.
 */
@Injectable()
export class CustomerAnalyticsService {
  private readonly cache = new TtlCache<CustomerSpendingAnalytics>(
    60_000,
    2000,
  );

  constructor(private readonly spend: SpendService) {}

  async getSpending(
    me: number,
    range: CustomerSpendRange,
    now: Date = new Date(),
  ): Promise<CustomerSpendingAnalytics> {
    const key = `customer-analytics:${me}:${range}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const result = await this.build(me, range, now);
    this.cache.set(key, result);
    return result;
  }

  async build(
    me: number,
    range: CustomerSpendRange,
    now: Date,
  ): Promise<CustomerSpendingAnalytics> {
    const window = resolveCustomerWindow(range, now);
    const { from, to } = window;

    const [
      totals,
      heldCents,
      hasPaymentsEver,
      byBucket,
      previousCents,
      firstPayment,
      categories,
      artisans,
      channels,
      largest,
    ] = await Promise.all([
      this.spend.totals(me, from, to),
      this.spend.heldCents(me),
      this.spend.hasPaymentsEver(me),
      this.spend.netByBucket(me, window.bucket, from, to),
      window.previous
        ? this.spend.netCentsBetween(
            me,
            window.previous.from,
            window.previous.to,
          )
        : Promise.resolve(null),
      range === 'all' ? this.spend.firstPaymentDate(me) : Promise.resolve(null),
      this.categoryRows(me, from, to),
      this.artisanRows(me, from, to),
      this.channelRows(me, from, to),
      this.largestRow(me, from, to),
    ]);

    const buckets =
      range === 'all'
        ? firstPayment
          ? monthBucketsBetween(firstPayment, now)
          : []
        : window.buckets;

    return {
      range,
      bucket: window.bucket,
      currency: CUSTOMER_CURRENCY,
      period: { from: from ? from.toISOString() : null, to: to.toISOString() },
      hasPaymentsEver,
      totals: {
        netSpent: centsToMoney(totals.netCents),
        grossPaid: centsToMoney(totals.grossCents),
        refunded: centsToMoney(totals.refundedCents),
        held: centsToMoney(heldCents),
        released: centsToMoney(totals.releasedCents),
        paymentsCount: totals.count,
        avgPayment: centsToMoney(
          totals.count ? Math.round(totals.netCents / totals.count) : 0,
        ),
        previousPeriodNetSpent:
          previousCents === null ? null : centsToMoney(previousCents),
      },
      series: buckets.map((bucketStart) => {
        const hit = byBucket.get(bucketStart);
        return {
          bucketStart,
          netSpent: centsToMoney(hit?.cents ?? 0),
          count: hit?.count ?? 0,
        };
      }),
      byCategory: mapCategories(categories, totals.netCents),
      byArtisan: mapArtisans(artisans),
      byChannel: mapChannels(channels, totals.netCents),
      largestPayment: largest
        ? {
            id: Number(largest.id),
            jobId: Number(largest.jobId),
            jobTitle: largest.jobTitle ?? null,
            amount: centsToMoney(toCents(largest.amount)),
            paidAt: iso(largest.paidAt),
          }
        : null,
    };
  }

  private categoryRows(me: number, from: Date | null, to: Date) {
    return this.spend
      .counted(me, from, to)
      .leftJoin('jobs', 'j', 'j.id = p.job_id')
      .leftJoin('services', 's', 's.id = j.service_id')
      .select('s.id', 'serviceId')
      .addSelect('s.name', 'serviceName')
      .addSelect(`COALESCE(SUM(${PAYMENT_NET_SQL}), 0)`, 'net')
      .addSelect('COUNT(*)', 'count')
      .groupBy('s.id')
      .addGroupBy('s.name')
      .getRawMany<CategoryRow>();
  }

  private artisanRows(me: number, from: Date | null, to: Date) {
    return this.spend
      .counted(me, from, to)
      .leftJoin('artisan_profiles', 'ap', 'ap.id = p.artisan_profile_id')
      .leftJoin('users', 'u', 'u.id = ap.user_id')
      .select('ap.id', 'artisanProfileId')
      .addSelect('MAX(ap.business_name)', 'businessName')
      .addSelect('MAX(u.firstname)', 'firstname')
      .addSelect('MAX(u.lastname)', 'lastname')
      .addSelect('MAX(u.profile_picture)', 'avatar')
      .addSelect(
        'BOOL_OR(u.id IS NULL OR u.deleted_at IS NOT NULL OR u.purged_at IS NOT NULL)',
        'artisanGone',
      )
      .addSelect(`COALESCE(SUM(${PAYMENT_NET_SQL}), 0)`, 'net')
      .addSelect('COUNT(DISTINCT p.job_id)', 'jobs')
      .addSelect(`MAX(${PAYMENT_DATE_SQL})`, 'lastPaidAt')
      .groupBy('ap.id')
      .orderBy('net', 'DESC')
      .addOrderBy('"lastPaidAt"', 'DESC')
      .limit(MAX_ARTISANS)
      .getRawMany<ArtisanRow>();
  }

  private channelRows(me: number, from: Date | null, to: Date) {
    return this.spend
      .counted(me, from, to)
      .select('p.channel', 'channel')
      .addSelect(`COALESCE(SUM(${PAYMENT_NET_SQL}), 0)`, 'net')
      .addSelect('COUNT(*)', 'count')
      .groupBy('p.channel')
      .getRawMany<ChannelRow>();
  }

  private largestRow(me: number, from: Date | null, to: Date) {
    return this.spend
      .counted(me, from, to)
      .leftJoin('jobs', 'j', 'j.id = p.job_id')
      .select('p.id', 'id')
      .addSelect('p.job_id', 'jobId')
      .addSelect('j.title', 'jobTitle')
      .addSelect('p.amount', 'amount')
      .addSelect(PAYMENT_DATE_SQL, 'paidAt')
      .orderBy('p.amount', 'DESC')
      .addOrderBy(PAYMENT_DATE_SQL, 'DESC')
      .addOrderBy('p.id', 'DESC')
      .limit(1)
      .getRawOne<LargestRow>();
  }
}
