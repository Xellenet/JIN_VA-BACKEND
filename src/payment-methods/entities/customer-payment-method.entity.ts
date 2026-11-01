import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type {
  MomoProviderCode,
  SavedMethodType,
} from '../payment-methods.constants';

/**
 * A customer's saved way to pay. Only display-safe label fields are stored
 * in the clear; the full mobile money number and the card's Paystack
 * authorization code are AES-256-GCM encrypted (`PaymentDataEncryptionService`),
 * and the number and the card signature are also kept as keyed hashes for
 * de-duplication. No PIN, card number or CVV is ever stored.
 */
@Entity('customer_payment_methods')
export class CustomerPaymentMethod {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id', type: 'int' })
  userId!: number;

  @Column({ type: 'varchar', length: 20 })
  type!: SavedMethodType;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault!: boolean;

  // ─── Mobile money (labels) ────────────────────────────────────────────────
  @Column({ type: 'varchar', length: 3, nullable: true })
  network!: MomoProviderCode | null;

  @Column({ name: 'number_prefix', type: 'varchar', length: 3, nullable: true })
  numberPrefix!: string | null;

  @Column({ name: 'number_last4', type: 'varchar', length: 4, nullable: true })
  numberLast4!: string | null;

  @Column({
    name: 'account_name',
    type: 'varchar',
    length: 120,
    nullable: true,
  })
  accountName!: string | null;

  @Column({ name: 'name_verified', type: 'boolean', default: false })
  nameVerified!: boolean;

  // ─── Mobile money (secret) ────────────────────────────────────────────────
  @Column({ name: 'number_encrypted', type: 'text', nullable: true })
  numberEncrypted!: string | null;

  @Column({ name: 'number_hash', type: 'varchar', length: 64, nullable: true })
  numberHash!: string | null;

  // ─── Card (labels) ────────────────────────────────────────────────────────
  @Column({ name: 'card_brand', type: 'varchar', length: 30, nullable: true })
  cardBrand!: string | null;

  @Column({ name: 'card_last4', type: 'varchar', length: 4, nullable: true })
  cardLast4!: string | null;

  @Column({ name: 'exp_month', type: 'smallint', nullable: true })
  expMonth!: number | null;

  @Column({ name: 'exp_year', type: 'smallint', nullable: true })
  expYear!: number | null;

  @Column({ name: 'card_bank', type: 'varchar', length: 100, nullable: true })
  cardBank!: string | null;

  // ─── Card (secret) ────────────────────────────────────────────────────────
  @Column({ name: 'authorization_encrypted', type: 'text', nullable: true })
  authorizationEncrypted!: string | null;

  @Column({
    name: 'signature_hash',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  signatureHash!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
