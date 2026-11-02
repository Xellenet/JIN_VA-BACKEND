import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Customer Experience v2 (NFR-6.2): an append-only record of security-relevant
 * changes a user makes to their own account. There is no update or delete API;
 * rows go when the account is purged (SEC-37) or after 12 months (daily cron).
 *
 * `fields_changed` and `details` carry field **names** and simple flags only,
 * never the values a user entered and never personal data.
 */
@Entity('account_security_events')
export class AccountSecurityEvent {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id', type: 'int' })
  userId!: number;

  @Column({ type: 'varchar', length: 60 })
  event!: string;

  @Column({ name: 'fields_changed', type: 'text', array: true, default: '{}' })
  fieldsChanged!: string[];

  @Column({ type: 'jsonb', nullable: true })
  details!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip!: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 256, nullable: true })
  userAgent!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
