import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { PaymentStatus } from '@common/types/enums';
import { splitCommaList } from '../../jobs/dto/get-my-jobs-query.dto';
import { CUSTOMER_SPEND_RANGES } from '../../customer-insights/customer-range';
import type { CustomerSpendRange } from '../../customer-insights/customer-range';

/** The longest window B3/B10 accept for `from`/`to`. */
export const MAX_HISTORY_SPAN_MONTHS = 24;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` → midnight UTC (= Accra). */
export function parseYmd(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** True when `[from, to]` is longer than `months` calendar months. */
export function spanExceedsMonths(
  from: Date,
  to: Date,
  months: number,
): boolean {
  const limit = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth() + months,
      from.getUTCDate(),
    ),
  );
  return to.getTime() > limit.getTime();
}

/** `to` must not be before `from`, and not more than 24 months after it. */
function IsValidHistorySpan(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isValidHistorySpan',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const from = (args.object as { from?: unknown }).from;
          if (typeof value !== 'string' || typeof from !== 'string')
            return true;
          if (!YMD.test(value) || !YMD.test(from)) return true;
          const f = parseYmd(from);
          const t = parseYmd(value);
          if (t.getTime() < f.getTime()) return false;
          return !spanExceedsMonths(f, t, MAX_HISTORY_SPAN_MONTHS);
        },
        defaultMessage: () =>
          `to must be on or after from, and at most ${MAX_HISTORY_SPAN_MONTHS} months after it`,
      },
    });
}

/** `range` cannot be combined with `from`/`to`. */
function IsNotWithDates(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isNotWithDates',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          if (value === undefined || value === null) return true;
          const o = args.object as { from?: unknown; to?: unknown };
          return o.from === undefined && o.to === undefined;
        },
        defaultMessage: () => 'range cannot be combined with from or to',
      },
    });
}

/**
 * Customer experience v2 (B3): the paginated `GET /payments/history`.
 *
 * Every filter only narrows the caller's own payments (SEC-3): an id the
 * customer never paid gives an empty page, never an error. There is no sort
 * parameter (SEC-24). Unknown fields, including `customerId`/`userId`, are
 * rejected by the global pipe.
 */
export class PaymentHistoryQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 1000, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    example: 'HELD,RELEASED',
    description: 'Comma list of payment statuses (1–8)',
  })
  @IsOptional()
  @Transform(({ value }) => splitCommaList(value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsEnum(PaymentStatus, { each: true })
  status?: PaymentStatus[];

  @ApiPropertyOptional({ enum: CUSTOMER_SPEND_RANGES })
  @IsOptional()
  @IsIn(CUSTOMER_SPEND_RANGES as unknown as string[])
  @IsNotWithDates()
  range?: CustomerSpendRange;

  @ApiPropertyOptional({ example: '2026-01-01', description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(YMD, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-30', description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(YMD, { message: 'to must be YYYY-MM-DD' })
  @IsValidHistorySpan()
  to?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  serviceId?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  artisanProfileId?: number;

  @ApiPropertyOptional({
    description: 'Job title or payment reference (1–100 characters)',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 100)
  search?: string;
}

/** B10: the same filters as B3, without `page` and `limit`. */
export class PaymentHistoryExportQueryDto extends OmitType(
  PaymentHistoryQueryDto,
  ['page', 'limit'] as const,
) {}

/** The parameters whose presence selects B3's paginated form. */
export const PAGINATED_HISTORY_PARAMS = [
  'page',
  'limit',
  'status',
  'range',
  'from',
  'to',
  'serviceId',
  'artisanProfileId',
  'search',
] as const;
