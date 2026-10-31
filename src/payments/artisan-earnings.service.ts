import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { Payment } from './entities/payment.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { PaymentStatus } from '@common/types/enums';
import {
  AccountSecurityService,
  SecurityEventInput,
} from '../account-security/account-security.service';
import {
  CustomerSpendRange,
  DEFAULT_CUSTOMER_SPEND_RANGE,
  isoMonth,
  monthBucketsBetween,
  resolveCustomerWindow,
} from '../customer-insights/customer-range';
import { centsToMoney, toCents } from '../customer-insights/spend.util';
import {
  ARTISAN_CURRENCY,
  CLIENT_GONE_SQL,
  clientName,
  COUNTED_SQL,
  EarningBalances,
  EarningStage,
  EARNING_DATE_SQL,
  failureReasonOf,
  FailureReason,
  hasPayout,
  queryBalances,
  resolveArtisanProfileId,
  STAGE_SQL,
  stageOf,
} from '../artisan-insights/earnings.util';
import { CSV_BOM, csvCell, csvLine, csvNumber } from './csv.util';
import { CsvSink, csvDateTime } from './customer-payment-history.service';
import {
  ArtisanStatementExportQueryDto,
  ArtisanStatementQueryDto,
} from './dto/artisan-statement-query.dto';

/** One statement row. Only these keys ever leave. */
export interface StatementItem {
  paymentId: number;
  jobId: number;
  jobTitle: string | null;
  clientName: string;
  gross: string;
  fee: string;
  net: string;
  refunded: string;
  payout: string | null;
  status: PaymentStatus;
  stage: EarningStage;
  transferReference: string | null;
  failureReason: FailureReason | null;
  paidAt: string | null;
  releasedAt: string | null;
  createdAt: string;
  date: string;
}

export interface StatementRawRow {
  id: number | string;
  jobId: number | string;
  jobTitle: string | null;
  clientFirstname: string | null;
  clientLastname: string | null;
  clientGone: boolean | null;
  amount: string | number;
  platformFee: string | number;
  artisanAmount: string | number;
  refundedAmount: string | number | null;
  status: PaymentStatus;
  transferStarted: boolean | null;
  transferReference: string | null;
  paidAt: Date | string | null;
  releasedAt: Date | string | null;
  createdAt: Date | string;
  earnedAt: Date | string;
  sortKey?: string;
}

export interface StatementMonth {
  month: string;
  gross: string;
  fee: string;
  net: string;
  jobs: number;
}

export interface StatementSummary {
  gross: string;
  fee: string;
  net: string;
  jobs: number;
  paid: string;
  refunded: string;
  refundedCount: number;
}

export interface ArtisanStatement {
  currency: string;
  period: { key: CustomerSpendRange; from: string | null; to: string };
  summary: StatementSummary;
  balances: EarningBalances;
  months: StatementMonth[];
  items: StatementItem[];
}

export const ARTISAN_EXPORT_MAX_ROWS = 10_000;
export const ARTISAN_EXPORT_BATCH_SIZE = 500;
export const ARTISAN_EXPORT_LIMIT_MESSAGE =
  'Narrow the period, then download again.';

export const ARTISAN_CSV_HEADER = [
  'Date',
  'Job',
  'Client',
  'Status',
  'Paid by client (GHS)',
  'Platform fee (GHS)',
  'Your payout (GHS)',
  'Refunded to client (GHS)',
  'Transfer reference',
  'Client paid',
  'Paid out',
];

/** Artisan-side CSV labels. Never "escrow" or "withheld" (copy rules). */
export function artisanStageLabel(stage: EarningStage): string {
  switch (stage) {
    case 'awaiting_payment':
      return 'Client has not paid yet';
    case 'held':
      return 'Paid by client, waiting for sign-off';
    case 'on_the_way':
      return 'On its way';
    case 'needs_action':
      return 'Needs your action';
    case 'paid':
      return 'Paid';
    case 'refunded':
      return 'Refunded to client';
    default:
      return 'Not paid';
  }
}

const isoOrNull = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

/** Explicit mapping: nothing from the entity is passed through. */
export function mapStatementRow(r: StatementRawRow): StatementItem {
  const stage = stageOf(r.status, !!r.transferStarted);
  const net = centsToMoney(toCents(r.artisanAmount));
  return {
    paymentId: Number(r.id),
    jobId: Number(r.jobId),
    jobTitle: r.jobTitle ?? null,
    clientName: clientName(r),
    gross: centsToMoney(toCents(r.amount)),
    fee: centsToMoney(toCents(r.platformFee)),
    net,
    refunded: centsToMoney(toCents(r.refundedAmount)),
    payout: hasPayout(stage) ? net : null,
    status: r.status,
    stage,
    transferReference: r.transferReference ?? null,
    failureReason: failureReasonOf(r.status),
    paidAt: isoOrNull(r.paidAt),
    releasedAt: isoOrNull(r.releasedAt),
    createdAt: new Date(r.createdAt).toISOString(),
    date: new Date(r.earnedAt).toISOString(),
  };
}

/** One CSV line for a statement row. */
export function artisanCsvRow(r: StatementItem): string {
  return csvLine([
    csvDateTime(r.date),
    csvCell(r.jobTitle ?? ''),
    csvCell(r.clientName),
    csvCell(artisanStageLabel(r.stage)),
    csvNumber(r.gross),
    csvNumber(r.fee),
    csvNumber(r.payout),
    csvNumber(r.refunded),
    csvCell(r.transferReference ?? ''),
    csvDateTime(r.paidAt),
    csvDateTime(r.releasedAt),
  ]);
}

type StatementFilters = Pick<
  ArtisanStatementQueryDto,
  'period' | 'stage' | 'jobId'
>;

/**
 * Artisan fixes (B2): the artisan's earnings statement and its CSV.
 *
 * Every query starts from `base(profileId)`, which binds
 * `p.artisan_profile_id` to the profile resolved from the JWT subject;
 * filters only narrow it. Rows are mapped explicitly, so Paystack codes,
 * fraud flags and the client's contact details never leave.
 */
@Injectable()
export class ArtisanEarningsService {
  private readonly logger = new Logger(ArtisanEarningsService.name);

  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(ArtisanProfile)
    private readonly profiles: Repository<ArtisanProfile>,
    private readonly security: AccountSecurityService,
  ) {}

  private base(profileId: number): SelectQueryBuilder<Payment> {
    return this.payments
      .createQueryBuilder('p')
      .leftJoin('jobs', 'j', 'j.id = p.job_id')
      .leftJoin('users', 'c', 'c.id = p.customer_id')
      .where('p.artisan_profile_id = :profileId', { profileId });
  }

  private selectRow(qb: SelectQueryBuilder<Payment>) {
    return qb
      .select('p.id', 'id')
      .addSelect('p.job_id', 'jobId')
      .addSelect('j.title', 'jobTitle')
      .addSelect('c.firstname', 'clientFirstname')
      .addSelect('c.lastname', 'clientLastname')
      .addSelect(CLIENT_GONE_SQL, 'clientGone')
      .addSelect('p.amount', 'amount')
      .addSelect('p.platform_fee', 'platformFee')
      .addSelect('p.artisan_amount', 'artisanAmount')
      .addSelect('p.refunded_amount', 'refundedAmount')
      .addSelect('p.status', 'status')
      .addSelect('(p.transfer_code IS NOT NULL)', 'transferStarted')
      .addSelect('p.transfer_reference', 'transferReference')
      .addSelect('p.paid_at', 'paidAt')
      .addSelect('p.released_at', 'releasedAt')
      .addSelect('p.created_at', 'createdAt')
      .addSelect(EARNING_DATE_SQL, 'earnedAt');
  }

  /** Narrows to the period (and, when `withStage`, the stages and job). */
  applyFilters(
    qb: SelectQueryBuilder<Payment>,
    q: StatementFilters,
    now: Date,
    withStage = true,
  ): SelectQueryBuilder<Payment> {
    const w = resolveCustomerWindow(
      q.period ?? DEFAULT_CUSTOMER_SPEND_RANGE,
      now,
    );
    if (w.from)
      qb.andWhere(`${EARNING_DATE_SQL} >= :periodFrom`, {
        periodFrom: w.from,
      });
    qb.andWhere(`${EARNING_DATE_SQL} <= :periodTo`, { periodTo: w.to });
    if (withStage && q.stage?.length) {
      qb.andWhere(`${STAGE_SQL} IN (:...stages)`, { stages: q.stage });
    }
    if (withStage && q.jobId) {
      qb.andWhere('p.job_id = :jobId', { jobId: q.jobId });
    }
    return qb;
  }

  async getStatement(
    me: number,
    q: ArtisanStatementQueryDto,
    now: Date = new Date(),
  ) {
    const profileId = await resolveArtisanProfileId(this.profiles, me);
    const period = q.period ?? DEFAULT_CUSTOMER_SPEND_RANGE;
    const w = resolveCustomerWindow(period, now);
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;

    const [summary, balances, months, total, rows] = await Promise.all([
      this.summary(profileId, q, now),
      queryBalances(this.payments, profileId, now),
      this.months(profileId, q, now),
      this.applyFilters(this.base(profileId), q, now).getCount(),
      this.applyFilters(this.selectRow(this.base(profileId)), q, now)
        .orderBy(EARNING_DATE_SQL, 'DESC')
        .addOrderBy('p.id', 'DESC')
        .offset((page - 1) * limit)
        .limit(limit)
        .getRawMany<StatementRawRow>(),
    ]);

    const data: ArtisanStatement = {
      currency: ARTISAN_CURRENCY,
      period: {
        key: period,
        from: w.from ? w.from.toISOString() : null,
        to: w.to.toISOString(),
      },
      summary,
      balances,
      months,
      items: rows.map(mapStatementRow),
    };
    return {
      message: 'Earnings statement retrieved',
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  private async summary(
    profileId: number,
    q: StatementFilters,
    now: Date,
  ): Promise<StatementSummary> {
    const row = await this.applyFilters(this.base(profileId), q, now, false)
      .select(
        `COALESCE(SUM(p.amount) FILTER (WHERE ${COUNTED_SQL}), 0)`,
        'gross',
      )
      .addSelect(
        `COALESCE(SUM(p.platform_fee) FILTER (WHERE ${COUNTED_SQL}), 0)`,
        'fee',
      )
      .addSelect(
        `COALESCE(SUM(p.artisan_amount) FILTER (WHERE ${COUNTED_SQL}), 0)`,
        'net',
      )
      .addSelect(`COUNT(*) FILTER (WHERE ${COUNTED_SQL})`, 'jobs')
      .addSelect(
        `COALESCE(SUM(p.artisan_amount) FILTER (WHERE p.status = '${PaymentStatus.RELEASED}'), 0)`,
        'paid',
      )
      .addSelect(
        `COALESCE(SUM(p.artisan_amount) FILTER (WHERE p.status = '${PaymentStatus.REFUNDED}'), 0)`,
        'refunded',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE p.status = '${PaymentStatus.REFUNDED}')`,
        'refundedCount',
      )
      .getRawOne<Record<string, string | number | null>>();
    return {
      gross: centsToMoney(toCents(row?.gross)),
      fee: centsToMoney(toCents(row?.fee)),
      net: centsToMoney(toCents(row?.net)),
      jobs: Number(row?.jobs ?? 0),
      paid: centsToMoney(toCents(row?.paid)),
      refunded: centsToMoney(toCents(row?.refunded)),
      refundedCount: Number(row?.refundedCount ?? 0),
    };
  }

  /** Counted payments per calendar month (Accra), zero-filled. */
  private async months(
    profileId: number,
    q: StatementFilters,
    now: Date,
  ): Promise<StatementMonth[]> {
    const monthSql = `TO_CHAR((${EARNING_DATE_SQL}) AT TIME ZONE 'Africa/Accra', 'YYYY-MM')`;
    const rows = await this.applyFilters(this.base(profileId), q, now, false)
      .andWhere(COUNTED_SQL)
      .select(monthSql, 'month')
      .addSelect('COALESCE(SUM(p.amount), 0)', 'gross')
      .addSelect('COALESCE(SUM(p.platform_fee), 0)', 'fee')
      .addSelect('COALESCE(SUM(p.artisan_amount), 0)', 'net')
      .addSelect('COUNT(*)', 'jobs')
      .groupBy(monthSql)
      .orderBy(monthSql, 'ASC')
      .getRawMany<{
        month: string;
        gross: string | number;
        fee: string | number;
        net: string | number;
        jobs: string | number;
      }>();
    const byMonth = new Map(rows.map((r) => [r.month, r]));
    const w = resolveCustomerWindow(
      q.period ?? DEFAULT_CUSTOMER_SPEND_RANGE,
      now,
    );
    let first: Date | null = w.from;
    if (!first) {
      if (rows.length === 0) return [];
      const [y, m] = rows[0].month.split('-').map(Number);
      first = new Date(Date.UTC(y, m - 1, 1));
    }
    return monthBucketsBetween(first, now).map((start) => {
      const key = isoMonth(new Date(`${start}T00:00:00.000Z`));
      const r = byMonth.get(key);
      return {
        month: key,
        gross: centsToMoney(toCents(r?.gross)),
        fee: centsToMoney(toCents(r?.fee)),
        net: centsToMoney(toCents(r?.net)),
        jobs: Number(r?.jobs ?? 0),
      };
    });
  }

  /** `jinva-earnings-YYYY-MM-DD.csv` (today in Accra; never a name). */
  static exportFileName(now = new Date()): string {
    return `jinva-earnings-${now.toISOString().slice(0, 10)}.csv`;
  }

  /**
   * B2 CSV: refuses (JSON 400) before streaming when over 10,000 rows, then
   * streams keyset batches of 500 and records the export without values.
   */
  async streamExport(
    me: number,
    q: ArtisanStatementExportQueryDto,
    sink: CsvSink,
    context: Pick<SecurityEventInput, 'ip' | 'userAgent'>,
    now: Date = new Date(),
  ): Promise<number> {
    const profileId = await resolveArtisanProfileId(this.profiles, me);
    const count = await this.applyFilters(
      this.base(profileId),
      q,
      now,
    ).getCount();
    if (count > ARTISAN_EXPORT_MAX_ROWS) {
      throw new BadRequestException({
        errorCode: 'EXPORT_TOO_MANY_ROWS',
        message: ARTISAN_EXPORT_LIMIT_MESSAGE,
      });
    }

    sink.status(200);
    sink.setHeader('Content-Type', 'text/csv; charset=utf-8');
    sink.setHeader(
      'Content-Disposition',
      `attachment; filename="${ArtisanEarningsService.exportFileName(now)}"`,
    );
    sink.setHeader('Cache-Control', 'no-store');
    sink.write(CSV_BOM + csvLine(ARTISAN_CSV_HEADER));

    let rowCount: number;
    try {
      rowCount = await this.writeBatches(profileId, q, sink, now);
    } catch (err) {
      this.logger.error(
        `Earnings CSV export stopped part-way: ${(err as Error)?.name ?? 'Error'}`,
      );
      sink.end();
      return 0;
    }

    await this.security.recordBestEffort({
      userId: me,
      event: 'spending_report.exported',
      details: {
        report: 'artisan_earnings',
        range: q.period ?? DEFAULT_CUSTOMER_SPEND_RANGE,
        statuses: q.stage ? [...q.stage] : [],
        rowCount,
      },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    });
    sink.end();
    return rowCount;
  }

  private async writeBatches(
    profileId: number,
    q: ArtisanStatementExportQueryDto,
    sink: CsvSink,
    now: Date,
  ): Promise<number> {
    let rowCount = 0;
    let after: { key: string; id: number } | null = null;
    for (;;) {
      const qb = this.applyFilters(this.selectRow(this.base(profileId)), q, now)
        .addSelect(`${EARNING_DATE_SQL}::text`, 'sortKey')
        .orderBy(EARNING_DATE_SQL, 'DESC')
        .addOrderBy('p.id', 'DESC')
        .limit(ARTISAN_EXPORT_BATCH_SIZE);
      if (after) {
        qb.andWhere(
          `(${EARNING_DATE_SQL}, p.id) < (CAST(:afterKey AS timestamptz), :afterId)`,
          { afterKey: after.key, afterId: after.id },
        );
      }
      const batch = await qb.getRawMany<StatementRawRow>();
      if (batch.length === 0) break;
      sink.write(batch.map((r) => artisanCsvRow(mapStatementRow(r))).join(''));
      rowCount += batch.length;
      const last = batch[batch.length - 1];
      after = { key: String(last.sortKey), id: Number(last.id) };
      if (
        batch.length < ARTISAN_EXPORT_BATCH_SIZE ||
        rowCount >= ARTISAN_EXPORT_MAX_ROWS
      )
        break;
    }
    return rowCount;
  }
}
