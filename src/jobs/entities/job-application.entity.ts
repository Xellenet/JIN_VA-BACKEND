import { ApplicationStatus } from '@common/types/enums';
import { User } from '@users/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  RelationId,
  UpdateDateColumn,
} from 'typeorm';
import { Job } from './job.entity';

/**
 * Represents an artisan's application to a posted job.
 * A single artisan may apply to a job only once (enforced by a unique
 * constraint on (job_id, artisan_id) in the database).
 */
@Entity('job_applications')
export class JobApplication {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Job, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job!: Job;

  @RelationId((app: JobApplication) => app.job)
  jobId!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'artisan_id' })
  artisan!: User;

  @RelationId((app: JobApplication) => app.artisan)
  artisanId!: number;

  /** Optional bid price proposed by the artisan. */
  @Column({ name: 'quote_price', type: 'decimal', precision: 10, scale: 2, nullable: true })
  quotePrice?: number;

  /** Optional cover message from the artisan. */
  @Column({ type: 'text', nullable: true })
  message?: string;

  @Column({ type: 'enum', enum: ApplicationStatus, default: ApplicationStatus.PENDING })
  status!: ApplicationStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt!: Date;
}
