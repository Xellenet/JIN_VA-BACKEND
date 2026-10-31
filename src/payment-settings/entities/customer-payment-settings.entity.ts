import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { MomoNetwork, PreferredChannel } from '../payment-settings.enums';

/**
 * B5: a customer's checkout preferences, one row per customer, created on the
 * first real save. There is no mobile money number (Q6 = No).
 */
@Entity('customer_payment_settings')
export class CustomerPaymentSettings {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id', type: 'int', unique: true })
  userId!: number;

  @Column({
    name: 'preferred_channel',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  preferredChannel!: PreferredChannel | null;

  @Column({ name: 'momo_network', type: 'varchar', length: 10, nullable: true })
  momoNetwork!: MomoNetwork | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
