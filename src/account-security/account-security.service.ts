import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Request } from 'express';
import { EntityManager, LessThan, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AccountSecurityEvent } from './entities/account-security-event.entity';

/** The only event names the table accepts (mirrored by its CHECK constraint). */
export const SECURITY_EVENT_NAMES = [
  'payment_settings.updated',
  'spending_report.exported',
  'profile_photo.removed',
] as const;

export type SecurityEventName = (typeof SECURITY_EVENT_NAMES)[number];

export interface SecurityEventInput {
  userId: number;
  event: SecurityEventName;
  /** Field names only, never values. */
  fieldsChanged?: string[];
  /** Primitives and string arrays only; never values a user typed or PII. */
  details?: Record<string, string | number | boolean | null | string[]>;
  ip?: string | null;
  /** Truncated to 256 characters inside. */
  userAgent?: string | null;
}

/** How long a security event is kept before the daily cron removes it. */
export const SECURITY_EVENT_RETENTION_MONTHS = 12;

const MAX_USER_AGENT = 256;
const MAX_IP = 45;

function truncate(value: string | null | undefined, max: number) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/** Drops anything in `details` that is not a primitive or a string array. */
function sanitiseDetails(
  details: SecurityEventInput['details'],
): Record<string, string | number | boolean | null | string[]> | null {
  if (!details || typeof details !== 'object') return null;
  const safe: Record<string, string | number | boolean | null | string[]> = {};
  for (const [key, value] of Object.entries(details)) {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      safe[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((item) => typeof item === 'string')
    ) {
      safe[key] = [...value];
    }
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

/** The caller's IP and user agent, for a security event. */
export function securityContextFrom(req: Request): {
  ip: string | null;
  userAgent: string | null;
} {
  const ip = typeof req?.ip === 'string' && req.ip ? req.ip : null;
  const header = req?.headers?.['user-agent'];
  const userAgent = typeof header === 'string' && header ? header : null;
  return {
    ip: truncate(ip, MAX_IP),
    userAgent: truncate(userAgent, MAX_USER_AGENT),
  };
}

@Injectable()
export class AccountSecurityService {
  private readonly logger = new Logger(AccountSecurityService.name);

  constructor(
    @InjectRepository(AccountSecurityEvent)
    private readonly events: Repository<AccountSecurityEvent>,
  ) {}

  private toRow(input: SecurityEventInput): Partial<AccountSecurityEvent> {
    return {
      userId: input.userId,
      event: input.event,
      fieldsChanged: [...(input.fieldsChanged ?? [])],
      details: sanitiseDetails(input.details),
      ip: truncate(input.ip, MAX_IP),
      userAgent: truncate(input.userAgent, MAX_USER_AGENT),
    };
  }

  /**
   * Writes one event. Throws on failure, so a caller that passes its
   * transaction's `manager` rolls the whole change back with it.
   */
  async record(
    input: SecurityEventInput,
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager
      ? manager.getRepository(AccountSecurityEvent)
      : this.events;
    await repo.insert(
      this.toRow(input) as QueryDeepPartialEntity<AccountSecurityEvent>,
    );
  }

  /** Writes one event; never throws. A failure is logged without PII. */
  async recordBestEffort(input: SecurityEventInput): Promise<void> {
    try {
      await this.record(input);
    } catch (err) {
      this.logger.warn(
        `Could not record security event ${input.event}: ${(err as Error)?.name ?? 'Error'}`,
      );
    }
  }

  /** Account purge (SEC-37): removes every event of this user. */
  async deleteForUser(manager: EntityManager, userId: number): Promise<void> {
    await manager.getRepository(AccountSecurityEvent).delete({ userId });
  }

  /** The cut-off before which events are removed. */
  static retentionCutoff(now: Date = new Date()): Date {
    const cutoff = new Date(now.getTime());
    cutoff.setUTCMonth(cutoff.getUTCMonth() - SECURITY_EVENT_RETENTION_MONTHS);
    return cutoff;
  }

  /** Daily: removes events older than 12 months. Returns how many went. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredEvents(now: Date = new Date()): Promise<number> {
    try {
      const result = await this.events.delete({
        createdAt: LessThan(AccountSecurityService.retentionCutoff(now)),
      });
      const removed = result.affected ?? 0;
      this.logger.log(
        `purgeExpiredEvents run summary: removed=${removed} retentionMonths=${SECURITY_EVENT_RETENTION_MONTHS}`,
      );
      return removed;
    } catch (err) {
      this.logger.error(
        `purgeExpiredEvents failed: ${(err as Error)?.name ?? 'Error'}`,
      );
      return 0;
    }
  }
}
