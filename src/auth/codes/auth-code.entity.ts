import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** What a code is for. A code only ever works for the purpose it was issued for. */
export const AUTH_CODE_PURPOSES = [
  'signup',
  'login',
  'password_reset',
] as const;
export type AuthCodePurpose = (typeof AUTH_CODE_PURPOSES)[number];

/**
 * Auth v2: one live 6-digit code (migration 1783370000000). Holds an
 * HMAC-SHA-256 of the code, never the code, and a keyed hash of the email,
 * never the address. Written only for a real account.
 */
@Entity('auth_codes')
export class AuthCode {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id', type: 'int', nullable: true })
  userId!: number | null;

  @Column({ name: 'email_hash', type: 'char', length: 64 })
  emailHash!: string;

  @Column({ type: 'varchar', length: 20 })
  purpose!: AuthCodePurpose;

  @Column({ name: 'code_hash', type: 'char', length: 64 })
  codeHash!: string;

  @Column({ type: 'smallint', default: 0 })
  attempts!: number;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

/**
 * Auth v2: per (email hash, purpose) send counters — the resend cooldown, the
 * hourly cap — and the failed-check counter. Kept for every address that asks,
 * registered or not, so these limits answer identically either way.
 */
@Entity('auth_code_requests')
export class AuthCodeRequest {
  @PrimaryColumn({ name: 'email_hash', type: 'char', length: 64 })
  emailHash!: string;

  @PrimaryColumn({ type: 'varchar', length: 20 })
  purpose!: AuthCodePurpose;

  @Column({ name: 'window_started_at', type: 'timestamptz' })
  windowStartedAt!: Date;

  @Column({ name: 'sent_in_window', type: 'smallint', default: 0 })
  sentInWindow!: number;

  @Column({ name: 'last_sent_at', type: 'timestamptz' })
  lastSentAt!: Date;

  @Column({ name: 'failed_checks', type: 'smallint', default: 0 })
  failedChecks!: number;
}
