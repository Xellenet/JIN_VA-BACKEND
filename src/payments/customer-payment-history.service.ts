import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, SelectQueryBuilder } from 'typeorm';
import { Payment } from './entities/payment.entity';
import { PaymentStatus } from '@common/types/enums';
import {
  AccountSecurityService,
  SecurityEventInput,
} from '../account-security/account-security.service';
import { resolveCustomerWindow } from '../customer-insights/customer-range';
import {
  centsToMoney,
  HELD_STATUSES,
  PAYMENT_DATE_SQL,
  toCents,
} from '../customer-insights/spend.util';
import { artisanRef } from '../customer-insights/customer-overview.service';
import { containsPattern } from './like-escape.util';
import { CSV_BOM, csvCell, csvLine, csvNumber } from './csv.util';
import {
  MAX_HISTORY_SPAN_MONTHS,
  parseYmd,
  PaymentHistoryExportQueryDto,
  PaymentHistoryQueryDto,
  spanExceedsMonths,
} from './dto/payment-history-query.dto';

/** One row of B3, in both forms. Only these keys ever leave (SEC-7). */
export interface PaymentHistoryRow {
  id: number;
  reference: string;
  jobId: number;
  job: { id: number; title: string | null };
  bookingId: number | null;
  service: { id: number | null; name: string };
  artisan: { id: number | null; displayName: string; avatar: string | null };
  amount: string;
  refundedAmount: string;
  netAmount: string;
  currency: string;
  channel: string | null;
  status: PaymentStatus;
  paidAt: string | null;
  releasedAt: string | null;
  date: string;
}

/** Raw history row from SQL, before mapping. */
export interface HistoryRawRow {
  id: number | string;
  reference: string;
  jobId: number | string;
  jobTitle: string | null;
  bookingId: number | string | null;
  serviceId: number | string | null;
  serviceName: string | null;
  artisanProfileId: number | string | null;
  businessName: string | null;
  firstname: string | null;
  lastname: string | null;
  avatar: string | null;
  artisanGone: boolean | null;
  amount: string | number;
  refundedAmount: string | number | null;
  currency: string;
  channel: string | null;
  status: PaymentStatus;
  paidAt: Date | string | null;
  releasedAt: Date | string | null;
  createdAt: Date | string;
  sortKey?: string;
}

export const EXPORT_MAX_ROWS = 10_000;
export const EXPORT_BATCH_SIZE = 500;
export const EXPORT_LIMIT_MESSAGE =
  'Narrow the date range to 24 months or less, then download again.';

export const CSV_HEADER = [
  'Date paid',
  'Reference',
  'Job',
  'Service',
  'Artisan',
  'Method',
  'Status',
  'Amount (GHS)',
  'Refunded (GHS)',
  'Net (GHS)',
  'Paid to artisan',
];

/** Customer labels for the CSV. Never "escrow" (owner's copy rule). */
export function customerStatusLabel(status: string): string {
  if ((HELD_STATUSES as string[]).includes(status)) return 'Withheld';
  switch (status as PaymentStatus) {
    case PaymentStatus.PENDING:
      return 'Awaiting payment';
    case PaymentStatus.RELEASED:
      return 'Paid Out';
    case PaymentStatus.REFUNDED:
      return 'Refunded';
    case PaymentStatus.CANCELLED:
      return 'Cancelled';
    case PaymentStatus.FAILED:
      return 'Failed';
    default:
      return status;
  }
}

/** CSV "Method" column. A payment never made has no method yet. */
export function methodLabel(channel: string | null, paidAt: unknown): string {
  if (!channel) return paidAt ? 'Other' : 'Not paid yet';
  switch (channel.toLowerCase()) {
    case 'mobile_money':
      return 'Mobile money';
    case 'card':
      return 'Card';
    case 'bank':
    case 'bank_transfer':
      return 'Bank';
    default:
      return 'Other';
  }
}

/** `YYYY-MM-DD HH:mm` in Accra (= UTC); empty when missing. */
export function csvDateTime(value: Date | string | null | undefined): string {
  if (!value) return '';
  return new Date(value).toISOString().slice(0, 16).replace('T', ' ');
}

const isoOrNull = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

/** Explicit mapping: nothing from the entity is passed through (SEC-7). */
export function mapHistoryRow(r: HistoryRawRow): PaymentHistoryRow {
  const amountCents = toCents(r.amount);
  const refundedCents = toCents(r.refundedAmount);
  const jobId = Number(r.jobId);
  return {
    id: Number(r.id),
    reference: r.reference,
    jobId,
    job: { id: jobId, title: r.jobTitle ?? null },
    bookingId: r.bookingId == null ? null : Number(r.bookingId),
    service:
      r.serviceId == null
        ? { id: null, name: 'Other' }
        : { id: Number(r.serviceId), name: r.serviceName ?? 'Other' },
    artisan: artisanRef(r),
    amount: centsToMoney(amountCents),
    refundedAmount: centsToMoney(refundedCents),
    netAmount: centsToMoney(amountCents - refundedCents),
    currency: r.currency,
    channel: r.channel ?? null,
    status: r.status,
    paidAt: isoOrNull(r.paidAt),
    releasedAt: isoOrNull(r.releasedAt),
    date: new Date(r.createdAt).toISOString(),
  };
}

/** One CSV line for a history row. */
export function csvRow(r: PaymentHistoryRow): string {
  return csvLine([
    csvDateTime(r.paidAt),
    csvCell(r.reference),
    csvCell(r.job.title ?? ''),
    csvCell(r.service.name),
    csvCell(r.artisan.displayName),
    csvCell(methodLabel(r.channel, r.paidAt)),
    csvCell(customerStatusLabel(r.status)),
    csvNumber(r.amount),
    csvNumber(r.refundedAmount),
    csvNumber(r.netAmount),
    csvDateTime(r.releasedAt),
  ]);
}

type HistoryFilters = Omit<PaymentHistoryQueryDto, 'page' | 'limit'>;

/** Minimal writable stream surface (Express `Response`). */
export interface CsvSink {
  setHeader(name: string, value: string): unknown;
  status(code: number): unknown;
  write(chunk: string): unknown;
  end(): unknown;
}

/**
 * Customer experience v2: the customer's payment history (B3), its filter
 * options (B3f) and the CSV export (B10).
 *
 * Every query starts from `base(me)`, which binds `p.customer_id = :me`;
 * filters can only narrow it (SEC-1, SEC-3). Rows are mapped explicitly, so
 * fees, transfer fields, fraud flags and artisan contact details never leave.
 */
@Injectable()
export class CustomerPaymentHistoryService {
  private readonly logger = new Logger(CustomerPaymentHistoryService.name);

  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    private readonly security: AccountSecurityService,
  ) {}

  /** The caller's payments, joined to the job, service and artisan. */
  private base(me: number): SelectQueryBuilder<Payment> {
    return this.payments
      .createQueryBuilder('p')
      .leftJoin('jobs', 'j', 'j.id = p.job_id')
      .leftJoin('services', 's', 's.id = j.service_id')
      .leftJoin('artisan_profiles', 'ap', 'ap.id = p.artisan_profile_id')
      .leftJoin('users', 'u', 'u.id = ap.user_id')
      .where('p.customer_id = :me', { me });
  }

  private selectRow(qb: SelectQueryBuilder<Payment>) {
    return qb
      .select('p.id', 'id')
      .addSelect('p.reference', 'reference')
      .addSelect('p.job_id', 'jobId')
      .addSelect('j.title', 'jobTitle')
      .addSelect('j.booking_id', 'bookingId')
      .addSelect('s.id', 'serviceId')
      .addSelect('s.name', 'serviceName')
      .addSelect('ap.id', 'artisanProfileId')
      .addSelect('ap.business_name', 'businessName')
      .addSelect('u.firstname', 'firstname')
      .addSelect('u.lastname', 'lastname')
      .addSelect('u.profile_picture', 'avatar')
      .addSelect(
        '(u.id IS NULL OR u.deleted_at IS NOT NULL OR u.purged_at IS NOT NULL)',
        'artisanGone',
      )
      .addSelect('p.amount', 'amount')
      .addSelect('p.refunded_amount', 'refundedAmount')
      .addSelect('p.currency', 'currency')
      .addSelect('p.channel', 'channel')
      .addSelect('p.status', 'status')
      .addSelect('p.paid_at', 'paidAt')
      .addSelect('p.released_at', 'releasedAt')
      .addSelect('p.created_at', 'createdAt');
  }

  /** Narrows `qb` by the query's filters. Never widens the owner scope. */
  applyFilters(
    qb: SelectQueryBuilder<Payment>,
    q: HistoryFilters,
    now: Date = new Date(),
  ): SelectQueryBuilder<Payment> {
    if (q.status?.length) {
      qb.andWhere('p.status IN (:...statuses)', { statuses: q.status });
    }
    if (q.range) {
      const w = resolveCustomerWindow(q.range, now);
      if (w.from)
        qb.andWhere(`${PAYMENT_DATE_SQL} >= :rangeFrom`, { rangeFrom: w.from });
      qb.andWhere(`${PAYMENT_DATE_SQL} <= :rangeTo`, { rangeTo: w.to });
    }
    if (q.from) {
      qb.andWhere(`${PAYMENT_DATE_SQL} >= :dateFrom`, {
        dateFrom: parseYmd(q.from),
      });
    }
    if (q.to) {
      const end = parseYmd(q.to);
      end.setUTCDate(end.getUTCDate() + 1); // inclusive Accra day
      qb.andWhere(`${PAYMENT_DATE_SQL} < :dateTo`, { dateTo: end });
    }
    if (q.serviceId) {
      qb.andWhere('j.service_id = :serviceId', { serviceId: q.serviceId });
    }
    if (q.artisanProfileId) {
      qb.andWhere('p.artisan_profile_id = :artisanProfileId', {
        artisanProfileId: q.artisanProfileId,
      });
    }
    if (q.search) {
      const pattern = containsPattern(q.search);
      qb.andWhere(
        new Brackets((w) => {
          w.where("j.title ILIKE :searchPattern ESCAPE '\\'", {
            searchPattern: pattern,
          }).orWhere("p.reference ILIKE :searchPattern ESCAPE '\\'", {
            searchPattern: pattern,
          });
        }),
      );
    }
    return qb;
  }

  /**
   * B3 legacy form (no parameters): today's unpaginated array in today's
   * order (`created_at DESC`) and message, with the new fields added.
   */
  async getLegacyHistory(me: number) {
    const rows = await this.selectRow(this.base(me))
      .orderBy('p.created_at', 'DESC')
      .addOrderBy('p.id', 'DESC')
      .getRawMany<HistoryRawRow>();
    return {
      message: 'Payment history retrieved.',
      data: rows.map(mapHistoryRow),
    };
  }

  /** B3 paginated form: newest paid first, then id. */
  async getHistoryPage(
    me: number,
    q: PaymentHistoryQueryDto,
    now = new Date(),
  ) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const total = await this.applyFilters(this.base(me), q, now).getCount();
    const rows = await this.applyFilters(this.selectRow(this.base(me)), q, now)
      .orderBy(PAYMENT_DATE_SQL, 'DESC')
      .addOrderBy('p.id', 'DESC')
      .offset((page - 1) * limit)
      .limit(limit)
      .getRawMany<HistoryRawRow>();
    return {
      message: 'Payment history retrieved',
      data: rows.map(mapHistoryRow),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * B3f: the services and artisans across **all** of the caller's payments,
   * for the history filter dropdowns. Deleted artisans are left out.
   */
  async getFilterOptions(me: number) {
    const [services, artisans] = await Promise.all([
      this.base(me)
        .select('s.id', 'id')
        .addSelect('s.name', 'name')
        .andWhere('s.id IS NOT NULL')
        .groupBy('s.id')
        .addGroupBy('s.name')
        .orderBy('s.name', 'ASC')
        .getRawMany<{ id: number | string; name: string }>(),
      this.base(me)
        .select('ap.id', 'id')
        .addSelect(
          "COALESCE(NULLIF(TRIM(ap.business_name), ''), TRIM(u.firstname || ' ' || u.lastname))",
          'displayName',
        )
        .andWhere('ap.id IS NOT NULL')
        .andWhere('u.id IS NOT NULL')
        .andWhere('u.deleted_at IS NULL')
        .andWhere('u.purged_at IS NULL')
        .groupBy('ap.id')
        .addGroupBy('ap.business_name')
        .addGroupBy('u.firstname')
        .addGroupBy('u.lastname')
        .orderBy('"displayName"', 'ASC')
        .addOrderBy('ap.id', 'ASC')
        .getRawMany<{ id: number | string; displayName: string }>(),
    ]);
    return {
      message: 'Payment history filters retrieved',
      data: {
        services: services.map((s) => ({ id: Number(s.id), name: s.name })),
        artisans: artisans.map((a) => ({
          id: Number(a.id),
          displayName: a.displayName || 'Artisan',
        })),
      },
    };
  }

  /**
   * B10: checks the export limits before anything is streamed, so a refusal
   * is a normal JSON 400 with `meta.error`.
   */
  async assertExportable(
    me: number,
    q: PaymentHistoryExportQueryDto,
    now = new Date(),
  ): Promise<number> {
    let start: Date | null = q.from ? parseYmd(q.from) : null;
    if (!start && q.range) start = resolveCustomerWindow(q.range, now).from;
    if (!start) {
      const first = await this.applyFilters(this.base(me), q, now)
        .select(`MIN(${PAYMENT_DATE_SQL})`, 'first')
        .getRawOne<{ first: Date | string | null }>();
      start = first?.first ? new Date(first.first) : null;
    }
    const end = q.to ? parseYmd(q.to) : now;
    if (start && spanExceedsMonths(start, end, MAX_HISTORY_SPAN_MONTHS)) {
      throw new BadRequestException({
        errorCode: 'EXPORT_RANGE_TOO_LARGE',
        message: EXPORT_LIMIT_MESSAGE,
      });
    }
    const count = await this.applyFilters(this.base(me), q, now).getCount();
    if (count > EXPORT_MAX_ROWS) {
      throw new BadRequestException({
        errorCode: 'EXPORT_TOO_MANY_ROWS',
        message: EXPORT_LIMIT_MESSAGE,
      });
    }
    return count;
  }

  /** `jinva-payments-YYYY-MM-DD.csv` (today in Accra; never a name or email). */
  static exportFileName(now = new Date()): string {
    return `jinva-payments-${now.toISOString().slice(0, 10)}.csv`;
  }

  /**
   * B10: streams the CSV in keyset batches of 500 (newest paid first), and
   * once every row is written records `spending_report.exported` with filter
   * flags and the row count only: never the search text, ids or row values.
   */
  async streamExport(
    me: number,
    q: PaymentHistoryExportQueryDto,
    sink: CsvSink,
    context: Pick<SecurityEventInput, 'ip' | 'userAgent'>,
    now = new Date(),
  ): Promise<number> {
    await this.assertExportable(me, q, now);

    sink.status(200);
    sink.setHeader('Content-Type', 'text/csv; charset=utf-8');
    sink.setHeader(
      'Content-Disposition',
      `attachment; filename="${CustomerPaymentHistoryService.exportFileName(now)}"`,
    );
    sink.setHeader('Cache-Control', 'no-store');
    sink.write(CSV_BOM + csvLine(CSV_HEADER));

    let rowCount: number;
    try {
      rowCount = await this.writeBatches(me, q, sink, now);
    } catch (err) {
      // Headers are already sent, so the exception filter cannot answer with
      // JSON any more. End the (truncated) file and log without PII; no
      // audit row, because no complete report left the server.
      this.logger.error(
        `CSV export stopped part-way: ${(err as Error)?.name ?? 'Error'}`,
      );
      sink.end();
      return 0;
    }

    // Recorded once every row is written and before the response ends, so
    // the download never completes without its audit row. Best effort: it
    // never throws, so it cannot break a finished file.
    await this.security.recordBestEffort({
      userId: me,
      event: 'spending_report.exported',
      details: {
        range: q.range ?? null,
        statuses: q.status ? [...q.status] : [],
        hasServiceFilter: !!q.serviceId,
        hasArtisanFilter: !!q.artisanProfileId,
        hasSearch: !!q.search,
        hasDateRange: !!(q.from || q.to),
        rowCount,
      },
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
    });
    sink.end();
    return rowCount;
  }

  /** Writes every matching row, 500 at a time, keyset-paginated. */
  private async writeBatches(
    me: number,
    q: PaymentHistoryExportQueryDto,
    sink: CsvSink,
    now: Date,
  ): Promise<number> {
    let rowCount = 0;
    let after: { key: string; id: number } | null = null;
    for (;;) {
      const qb = this.applyFilters(this.selectRow(this.base(me)), q, now)
        .addSelect(`${PAYMENT_DATE_SQL}::text`, 'sortKey')
        .orderBy(PAYMENT_DATE_SQL, 'DESC')
        .addOrderBy('p.id', 'DESC')
        .limit(EXPORT_BATCH_SIZE);
      if (after) {
        qb.andWhere(
          `(${PAYMENT_DATE_SQL}, p.id) < (CAST(:afterKey AS timestamptz), :afterId)`,
          { afterKey: after.key, afterId: after.id },
        );
      }
      const batch = await qb.getRawMany<HistoryRawRow>();
      if (batch.length === 0) break;
      sink.write(batch.map((r) => csvRow(mapHistoryRow(r))).join(''));
      rowCount += batch.length;
      const last = batch[batch.length - 1];
      after = { key: String(last.sortKey), id: Number(last.id) };
      if (batch.length < EXPORT_BATCH_SIZE || rowCount >= EXPORT_MAX_ROWS)
        break;
    }
    return rowCount;
  }
}
