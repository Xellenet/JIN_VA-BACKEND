import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AdminActionTarget, AdminActionType } from '@common/types/enums';

/**
 * AT5: append-only accountability log for every consequential admin action —
 * ban/unban, suspend/activate, verification approve/reject, portfolio
 * approve/reject, dispute resolve/close (including the verdict and any money
 * action), admin refunds and fraud flags.
 *
 * Shape is reused **exactly** from `ReviewModerationAction`: deliberately
 * **no foreign keys** to `users`, `payments`, `disputes`, `portfolio_items` or
 * `artisan_verifications`, and every identifying value captured as a plain
 * snapshot column at the moment the action happens. The whole point of the
 * table is to remain a complete, readable record after the thing it describes
 * (and potentially the acting admin's own account) no longer exists, so a
 * relation that could cascade-delete or dangle would defeat it.
 *
 * This does **not** replace or absorb `review_moderation_actions`, which stays
 * exactly as the reviews round built it.
 */
@Entity('admin_actions')
export class AdminAction {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 40 })
  action!: AdminActionType;

  /** What kind of thing was acted on — no FK, see class doc. */
  @Column({ name: 'target_type', type: 'varchar', length: 20 })
  targetType!: AdminActionTarget;

  @Column({ name: 'target_id', type: 'int' })
  targetId!: number;

  /**
   * Human-readable snapshot of the target at action time (a user's email, a
   * payment reference, "Dispute #42 · booking #77"). The only thing that keeps
   * the row meaningful once `targetId` points at a deleted row.
   */
  @Column({
    name: 'target_label',
    type: 'varchar',
    length: 200,
    nullable: true,
  })
  targetLabel?: string | null;

  /** Reason/note the admin gave. Null where the action takes none. */
  @Column({ type: 'text', nullable: true })
  reason?: string | null;

  @Column({ name: 'actor_id', type: 'int' })
  actorId!: number;

  @Column({ name: 'actor_name', type: 'varchar', nullable: true })
  actorName?: string | null;

  @Column({ name: 'actor_email', type: 'varchar', nullable: true })
  actorEmail?: string | null;

  /**
   * AT5 + DR1: the dispute verdict (`REFUND_CLIENT` / `RELEASE_ARTISAN` /
   * `MUTUAL`) for a dispute ruling. Null for every other action type.
   */
  @Column({ type: 'varchar', length: 30, nullable: true })
  outcome?: string | null;

  /**
   * AT5 + DR2: whether money actually moved as part of this action
   * (`NONE`/`REFUND`/`RELEASE`), so a ruling that moved money is traceable
   * independently of the dispute row itself.
   */
  @Column({ name: 'money_action', type: 'varchar', length: 20, nullable: true })
  moneyAction?: string | null;

  /** GHS amount moved by this action, where one moved. */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  amount?: number | null;

  /** Small, free-form extras (e.g. the payment id a ruling acted on). */
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;
}
