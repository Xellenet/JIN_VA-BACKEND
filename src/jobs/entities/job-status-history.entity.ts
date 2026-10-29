import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Status } from '@common/types/enums';
import { Job } from './job.entity';

/**
 * J3: an append-only audit trail of every status transition a job goes
 * through, replacing the frontend's previously-fabricated 4-step timeline.
 * `changedBy` is either the acting user's numeric ID (as a string) or the
 * literal `'SYSTEM'` for cron-driven transitions (J2 auto-complete, the
 * pre-existing open-posting expiry cron).
 */
@Entity('job_status_history')
export class JobStatusHistory {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Job, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job!: Job;

  @Column({ name: 'job_id' })
  jobId!: number;

  /** Null only for the very first row (job creation has no prior status). */
  @Column({ name: 'from_status', type: 'varchar', length: 20, nullable: true })
  fromStatus?: Status | null;

  @Column({ name: 'to_status', type: 'varchar', length: 20 })
  toStatus!: Status;

  /** Numeric user ID as a string, or the literal 'SYSTEM' for cron-driven transitions. */
  @Column({ name: 'changed_by', type: 'varchar', length: 20 })
  changedBy!: string;

  @Column({ type: 'text', nullable: true })
  reason?: string | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
    precision: 3,
  })
  createdAt!: Date;
}
