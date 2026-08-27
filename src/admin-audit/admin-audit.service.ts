import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { Repository } from 'typeorm';
import { AdminAction } from './entities/admin-action.entity';
import { AdminActionResponseDto } from './dto/admin-action-response.dto';
import { GetAdminActionsQueryDto } from './dto/get-admin-actions-query.dto';
import { AdminActionTarget, AdminActionType } from '@common/types/enums';

/** What a caller supplies to append one row to the log. */
export interface RecordAdminActionInput {
  action: AdminActionType;
  targetType: AdminActionTarget;
  targetId: number;
  /** Human-readable snapshot of the target (email, reference, title). */
  targetLabel?: string | null;
  reason?: string | null;
  actorId: number;
  actorName?: string | null;
  actorEmail?: string | null;
  /** DR1: the dispute verdict, for dispute rulings only. */
  outcome?: string | null;
  /** DR2: whether money moved, for rulings and refunds. */
  moneyAction?: string | null;
  amount?: number | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * AT5: the only writer of `admin_actions`.
 *
 * Lives in its own module (rather than inside `AdminModule`) precisely so
 * every module that performs an auditable action — disputes, payments,
 * portfolio, verification, admin — can depend on it without an import cycle:
 * `AdminModule` already imports most of those, so putting the writer there
 * would make the dependency graph circular.
 *
 * Writes are **best-effort**. An audit row is accountability metadata about an
 * action that has already committed; failing the admin's ban/refund/ruling
 * because the log insert failed would turn a bookkeeping problem into an
 * operational one. Failures are logged loudly instead.
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(
    @InjectRepository(AdminAction)
    private readonly repo: Repository<AdminAction>,
  ) {}

  async record(input: RecordAdminActionInput): Promise<void> {
    try {
      await this.repo.save(
        this.repo.create({
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          targetLabel: this.truncate(input.targetLabel, 200),
          reason: input.reason ?? null,
          actorId: input.actorId,
          actorName: input.actorName ?? null,
          actorEmail: input.actorEmail ?? null,
          outcome: input.outcome ?? null,
          moneyAction: input.moneyAction ?? null,
          amount: input.amount ?? null,
          metadata: input.metadata ?? null,
        }),
      );
    } catch (err) {
      this.logger.error(
        `Failed to write admin_actions row (${input.action} on ` +
          `${input.targetType}#${input.targetId} by admin ${input.actorId}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * AT5 read path: paginated, newest-first, filterable by action type and by
   * acting admin. Also filterable by target so the frontend's shared
   * "Action history" dialog can scope to one entity.
   */
  async findAll(query: GetAdminActionsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.repo
      .createQueryBuilder('a')
      .orderBy('a.createdAt', 'DESC')
      .addOrderBy('a.id', 'DESC');

    if (query.action) {
      qb.andWhere('a.action = :action', { action: query.action });
    }
    if (query.actorId !== undefined) {
      qb.andWhere('a.actorId = :actorId', { actorId: query.actorId });
    }
    if (query.targetType) {
      qb.andWhere('a.targetType = :targetType', {
        targetType: query.targetType,
      });
    }
    if (query.targetId !== undefined) {
      qb.andWhere('a.targetId = :targetId', { targetId: query.targetId });
    }

    const [entries, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      message: 'Admin action log retrieved.',
      data: plainToInstance(AdminActionResponseDto, entries, {
        excludeExtraneousValues: true,
      }),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  private truncate(value: string | null | undefined, max: number) {
    if (!value) return value ?? null;
    return value.length > max ? value.slice(0, max) : value;
  }
}
