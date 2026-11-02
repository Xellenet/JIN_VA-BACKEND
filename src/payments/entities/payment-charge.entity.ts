import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const CHARGE_STATUSES = [
  'pending',
  'needs_otp',
  'hosted_open',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
  'duplicate',
] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

/**
 * The statuses of an attempt that may still take the customer's money. At
 * most one attempt per payment is in one of them (partial unique index
 * `uq_payment_charges_one_active`).
 */
export const ACTIVE_CHARGE_STATUSES = [
  'pending',
  'needs_otp',
  'hosted_open',
] as const;
export type ActiveChargeStatus = (typeof ACTIVE_CHARGE_STATUSES)[number];

export function isActiveCharge(status: string): status is ActiveChargeStatus {
  return (ACTIVE_CHARGE_STATUSES as readonly string[]).includes(status);
}

/** How the attempt pays: the hosted checkout or a saved method. */
export type ChargeMethodType = 'mobile_money' | 'card' | 'hosted';

/**
 * Refund of a duplicate payment: `pending` (due, retried with backoff),
 * `processing` (a call is in flight, leased), `requested` (Paystack took it),
 * `processed` / `failed` (Paystack's refund webhooks).
 */
export type RefundStatus =
  | 'pending'
  | 'processing'
  | 'requested'
  | 'processed'
  | 'failed';

/**
 * One attempt to pay a job: the hosted checkout (`hosted`, with the session
 * Paystack handed back) or a direct charge of a saved method. Each attempt
 * has its own Paystack reference, because a failed charge uses its
 * reference up (the first hosted attempt uses the payment's own reference).
 * `charge.success` and verify resolve any of them to the same payment and
 * the same locked PENDING → HELD transition.
 *
 * Holds no personal data: the method is referenced by id only.
 */
@Entity('payment_charges')
export class PaymentCharge {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'payment_id', type: 'int' })
  paymentId!: number;

  @Column({ name: 'customer_id', type: 'int' })
  customerId!: number;

  @Column({ type: 'varchar', length: 100, unique: true })
  reference!: string;

  @Column({ name: 'method_type', type: 'varchar', length: 20 })
  methodType!: ChargeMethodType;

  @Column({ name: 'payment_method_id', type: 'int', nullable: true })
  paymentMethodId!: number | null;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: ChargeStatus;

  /** What the customer needs to do next (see `ChargeAction`). */
  @Column({ type: 'varchar', length: 30, nullable: true })
  action!: string | null;

  /** Customer-safe text only (never a raw provider error). */
  @Column({ type: 'varchar', length: 200, nullable: true })
  message!: string | null;

  @Column({ name: 'last_verified_at', type: 'timestamptz', nullable: true })
  lastVerifiedAt!: Date | null;

  /** Hosted only: the checkout session, returned again while it is open. */
  @Column({ name: 'authorization_url', type: 'text', nullable: true })
  authorizationUrl!: string | null;

  @Column({ name: 'access_code', type: 'varchar', length: 100, nullable: true })
  accessCode!: string | null;

  /**
   * After this, the attempt may be released, but only once Paystack says it
   * did not succeed.
   */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  /** The channel Paystack reported when it succeeded. */
  @Column({ type: 'varchar', length: 30, nullable: true })
  channel!: string | null;

  @Column({
    name: 'refund_status',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  refundStatus!: RefundStatus | null;

  /** Paystack's refund id. */
  @Column({ name: 'refund_id', type: 'varchar', length: 64, nullable: true })
  refundId!: string | null;

  @Column({
    name: 'refund_amount',
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
  })
  refundAmount!: string | number | null;

  @Column({ name: 'refund_attempts', type: 'smallint', default: 0 })
  refundAttempts!: number;

  @Column({ name: 'refund_next_at', type: 'timestamptz', nullable: true })
  refundNextAt!: Date | null;

  @Column({ name: 'refunded_at', type: 'timestamptz', nullable: true })
  refundedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
