import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Job } from '@jobs/entities/job.entity';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { PaymentStatus } from '@common/types/enums';
import type { PayoutHoldReason } from '../payout-hold';

@Entity('payments')
export class Payment {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Job, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job!: Job;

  @Column({ name: 'job_id' })
  jobId!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer!: User;

  @Column({ name: 'customer_id' })
  customerId!: number;

  @ManyToOne(() => ArtisanProfile, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'artisan_profile_id' })
  artisanProfile!: ArtisanProfile;

  @Column({ name: 'artisan_profile_id' })
  artisanProfileId!: number;

  /** Total amount the customer pays (GHS) */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount!: number;

  /** Platform commission deducted before artisan payout (GHS) */
  @Column({ name: 'platform_fee', type: 'decimal', precision: 10, scale: 2 })
  platformFee!: number;

  /** Amount transferred to artisan = amount − platformFee (GHS) */
  @Column({ name: 'artisan_amount', type: 'decimal', precision: 10, scale: 2 })
  artisanAmount!: number;

  @Column({ type: 'varchar', length: 3, default: 'GHS' })
  currency!: string;

  @Column({ type: 'varchar', length: 25, default: PaymentStatus.PENDING })
  status!: PaymentStatus;

  /** Reference we generated; also used as Paystack transaction reference */
  @Column({ unique: true, length: 100 })
  reference!: string;

  /** Authorization URL returned by Paystack for customer redirect */
  @Column({ name: 'authorization_url', type: 'text', nullable: true })
  authorizationUrl?: string;

  /** Paystack access code for inline JS popup */
  @Column({ name: 'access_code', nullable: true })
  accessCode?: string;

  /** Payment channel: 'card', 'mobile_money', 'bank' */
  @Column({ nullable: true })
  channel?: string;

  /** Reference for the outbound Transfer to artisan */
  @Column({ name: 'transfer_reference', nullable: true })
  transferReference?: string;

  /** Paystack transfer_code for tracking payout status */
  @Column({ name: 'transfer_code', nullable: true })
  transferCode?: string;

  /**
   * Cumulative amount refunded so far (GHS). Tracked separately from `amount`
   * so a partial refund can be validated against the *remaining* refundable
   * balance rather than the original total, and so the actual refunded
   * amount survives after `status` flips to REFUNDED on a full refund.
   * See security-report.md finding #4 and qa-report.md's "partial-refund
   * amount isn't persisted" finding.
   */
  @Column({
    name: 'refunded_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
  })
  refundedAmount!: number;

  /**
   * AT7: manual fraud-review marker set by an admin with a mandatory reason.
   *
   * Deliberately kept **separate from `status`**: a payment can be both
   * `RELEASED` and flagged, and folding this into `status` would fork the
   * settled payment-status vocabulary the frontend's shared
   * `paymentStatusConfig` map is the single source for. Marking, visibility
   * and auditing only — the flag has no enforcement effect on payouts or
   * refunds (Open Question 9, resolved).
   */
  @Column({ name: 'fraud_flagged', type: 'boolean', default: false })
  fraudFlagged!: boolean;

  @Column({ name: 'fraud_flag_reason', type: 'text', nullable: true })
  fraudFlagReason?: string | null;

  @Column({ name: 'fraud_flagged_at', type: 'timestamptz', nullable: true })
  fraudFlaggedAt?: Date | null;

  @Column({ name: 'fraud_flagged_by_id', type: 'int', nullable: true })
  fraudFlaggedById?: number | null;

  /**
   * Payout name check: why the payout is held (`PayoutHoldReason`), set only
   * while the payment is PENDING_TRANSFER; null when there is no hold, or when
   * the hold is the older "no payout method" case. Cleared when a transfer
   * starts.
   */
  @Column({
    name: 'payout_hold_reason',
    type: 'varchar',
    length: 40,
    nullable: true,
  })
  payoutHoldReason?: PayoutHoldReason | null;

  /** Checks in a row that couldn't be made (Paystack unavailable). */
  @Column({ name: 'payout_check_attempts', type: 'int', default: 0 })
  payoutCheckAttempts!: number;

  /** When the scheduler retries a pending check; null when none is due. */
  @Column({ name: 'payout_check_next_at', type: 'timestamptz', nullable: true })
  payoutCheckNextAt?: Date | null;

  /** When the artisan was told about a hold: once per payment. */
  @Column({
    name: 'payout_hold_notified_at',
    type: 'timestamptz',
    nullable: true,
  })
  payoutHoldNotifiedAt?: Date | null;

  /**
   * Saved payment methods: the customer ticked "Save this card for next
   * time" on the last initialise. Only this (never webhook metadata alone)
   * allows the card from a successful hosted charge to be saved.
   */
  @Column({ name: 'save_card_requested', type: 'boolean', default: false })
  saveCardRequested!: boolean;

  /**
   * The reference whose money this payment holds (the hosted checkout's or a
   * saved-method charge's). Set on the move to HELD; never refunded as a
   * duplicate. Null on payments that were never paid.
   */
  @Column({
    name: 'paid_reference',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  paidReference!: string | null;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt?: Date;

  @Column({ name: 'released_at', type: 'timestamptz', nullable: true })
  releasedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
