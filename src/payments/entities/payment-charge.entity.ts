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
  'succeeded',
  'failed',
  'duplicate',
] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

/**
 * One attempt to pay a job's payment with a saved method (direct Paystack
 * charge). Each attempt has its own Paystack reference, because a failed
 * charge uses its reference up; the payment row keeps its own reference for
 * the hosted checkout. The `charge.success` webhook resolves either one to
 * the same payment and the same PENDING → HELD transition.
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
  methodType!: 'mobile_money' | 'card';

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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
