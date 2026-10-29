import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ModerationAction } from '@common/types/enums';

/**
 * AM5: append-only accountability log — one row per flag/remove/restore
 * action. Required because AM3's "remove" is a genuine hard delete: once a
 * review row is gone, this table is the *only* surviving record of who
 * removed it, when, and why.
 *
 * Deliberately **not** foreign-keyed to `reviews`, `users`, or
 * `artisan_profiles` — the whole point of this table is to remain a
 * complete, readable record even after the review it describes (and
 * potentially the actor/reviewer/artisan accounts) no longer exist. Every
 * field that matters for a human reading the log later is captured as a
 * plain snapshot value at the moment the action happens, not as a relation
 * that could later cascade-delete or dangle.
 */
@Entity('review_moderation_actions')
export class ReviewModerationAction {
  @PrimaryGeneratedColumn()
  id!: number;

  /**
   * The review this action was taken against. No FK — see class doc.
   *
   * Together with `actorId`, unique at the DB level for `action = 'FLAG'`
   * rows via the partial unique index
   * `UQ_review_moderation_actions_flag_review_actor` (added by
   * `AddReviewModerationActionsFlagUniqueIndex1783090000000`) — closes a
   * concurrent-request race on `ReviewsService.flag()`'s "already flagged
   * by you" check. REMOVE/RESTORE rows are intentionally not constrained.
   */
  @Column({ name: 'review_id' })
  reviewId!: number;

  @Column({ type: 'varchar', length: 20 })
  action!: ModerationAction;

  /**
   * Required for FLAG and REMOVE. Null for RESTORE, which the design spec
   * treats as a low-stakes, single-click reversal of a flag that doesn't
   * need its own reason capture.
   */
  @Column({ type: 'text', nullable: true })
  reason?: string | null;

  /** The admin (remove/restore) or authenticated user (flag) who acted. */
  @Column({ name: 'actor_id' })
  actorId!: number;

  @Column({ name: 'actor_name', nullable: true })
  actorName?: string;

  @Column({ name: 'actor_role', type: 'varchar', length: 20, nullable: true })
  actorRole?: string;

  @Column({ name: 'reviewer_id', nullable: true })
  reviewerId?: number;

  @Column({ name: 'reviewer_name', nullable: true })
  reviewerName?: string;

  @Column({ name: 'artisan_profile_id', nullable: true })
  artisanProfileId?: number;

  @Column({ name: 'artisan_name', nullable: true })
  artisanName?: string;

  @Column({ type: 'decimal', precision: 3, scale: 2, nullable: true })
  rating?: number;

  /** First ~200 chars of the review text at the time of the action. */
  @Column({
    name: 'review_excerpt',
    type: 'varchar',
    length: 200,
    nullable: true,
  })
  reviewExcerpt?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;
}
