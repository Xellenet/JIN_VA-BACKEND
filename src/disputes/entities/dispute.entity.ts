import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  DisputeCategory,
  DisputeMoneyAction,
  DisputeOutcome,
  DisputeStatus,
} from '@common/types/enums';
import { Booking } from '../../bookings/entities/booking.entity';
import { User } from '../../users/entities/user.entity';

@Entity('disputes')
export class Dispute {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Booking, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'booking_id' })
  booking!: Booking;

  @Column({ name: 'booking_id' })
  bookingId!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'raised_by_id' })
  raisedBy!: User;

  @Column({ name: 'raised_by_id' })
  raisedById!: number;

  @Column({ type: 'text' })
  reason!: string;

  /**
   * DR5: fixed-list category picked at filing time, alongside the free-text
   * `reason`. Nullable at the DB level so pre-existing rows (filed before
   * this column existed) stay readable; `CreateDisputeDto` makes it required
   * on every new dispute, and reads fall back to `OTHER` for the legacy rows.
   */
  @Column({ type: 'varchar', length: 30, nullable: true })
  category?: DisputeCategory;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 20,
    default: DisputeStatus.OPEN,
  })
  status!: DisputeStatus;

  /**
   * DR4: the counterparty's single written response. Stored distinctly from
   * the raiser's `reason` so the admin detail surface can show "the client's
   * claim" and "the artisan's response" as two separately-attributed things,
   * which is PRD §5.13's literal requirement.
   */
  @Column({ name: 'response', type: 'text', nullable: true })
  response?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'responded_by_id' })
  respondedBy?: User;

  @Column({ name: 'responded_by_id', nullable: true })
  respondedById?: number;

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt?: Date;

  /** DR1: admin-only internal notes. Never exposed on a party-facing read. */
  @Column({ name: 'admin_notes', type: 'text', nullable: true })
  adminNotes?: string | null;

  /**
   * Every column a ruling writes is typed `| null` from here down,
   * deliberately: a failed money action has to be able to *clear* them, and
   * `undefined` cannot express that. TypeORM skips an `undefined` property —
   * `save()` reads it as "not provided" and `UpdateQueryBuilder` strips it
   * from the statement outright ("it doesn't make sense to update undefined
   * properties, so just skip them") — so only an explicit `null` empties a
   * nullable column. Passing `undefined` is what left a rolled-back ruling's
   * verdict, note, resolver and timestamp on the row (qa-report.md
   * QA-DC1-01, security-report.md B2), the same defect `1d5ce20` fixed for
   * `User.bannedAt`/`suspendedAt`.
   */
  @Column({ name: 'resolution', type: 'text', nullable: true })
  resolution?: string | null;

  /**
   * DR1: which of the three PRD verdicts the admin ruled. Set only on
   * `resolve`; a dispute closed via `close` (no verdict) leaves this null,
   * exactly as it does today.
   */
  @Column({ name: 'outcome', type: 'varchar', length: 20, nullable: true })
  outcome?: DisputeOutcome | null;

  /**
   * DR2: what actually happened to the money. `NONE` is a real, common answer
   * (MUTUAL verdict, no linked payment, or a payment already
   * refunded/released), and is recorded explicitly rather than left null so a
   * reader can tell "we decided no money moves" from "nobody has ruled yet".
   *
   * Together with `moneyPaymentId` this is also the *claim* on a payment: it
   * is written before the provider call so the partial unique index
   * `uq_disputes_money_payment` can stop a sibling dispute moving the same
   * money concurrently (B3), and cleared again if the movement fails.
   */
  @Column({
    name: 'money_action',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  moneyAction?: DisputeMoneyAction | null;

  /**
   * DR2: GHS amount actually moved by the money action. Null when NONE, and
   * null while a movement is still in flight — unlike `moneyAction`, this is
   * only ever written from a *completed* movement.
   */
  @Column({
    name: 'money_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
  })
  moneyAmount?: number | null;

  /**
   * DR2: the payment the money action was carried out against. Deliberately
   * a plain id, not a relation — it is a record of what was acted on at
   * ruling time and must survive the payment row being removed.
   */
  @Column({ name: 'money_payment_id', type: 'int', nullable: true })
  moneyPaymentId?: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'resolved_by_id' })
  resolvedBy?: User | null;

  @Column({ name: 'resolved_by_id', nullable: true })
  resolvedById?: number | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
