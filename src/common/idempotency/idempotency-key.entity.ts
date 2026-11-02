import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * The first response to a POST that carried an `Idempotency-Key`, per
 * (user, route, key), replayed for 24 hours. `fingerprint` is a SHA-256 of
 * the method, path and canonical body, so a key reused for a different
 * request is refused instead of replayed. Holds no request values: only the
 * response the same user already received.
 */
@Entity('idempotency_keys')
export class IdempotencyKey {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id', type: 'int' })
  userId!: number;

  @Column({ type: 'varchar', length: 64 })
  key!: string;

  @Column({ type: 'varchar', length: 80 })
  route!: string;

  @Column({ type: 'char', length: 64 })
  fingerprint!: string;

  @Column({ type: 'varchar', length: 12, default: 'in_progress' })
  state!: 'in_progress' | 'completed';

  @Column({ name: 'response_status', type: 'smallint', nullable: true })
  responseStatus!: number | null;

  @Column({ name: 'response_body', type: 'jsonb', nullable: true })
  responseBody!: StoredResponse | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;
}

/** A stored outcome: the handler's return value, or the HTTP error it threw. */
export type StoredResponse =
  | { kind: 'success'; body: unknown }
  | { kind: 'error'; name: string; body: unknown };
