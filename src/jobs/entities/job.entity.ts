import { Status } from '@common/types/enums';
import { ServiceEntity } from '@services/entities/service.entity';
import { User } from '@users/entities/user.entity';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  RelationId,
  UpdateDateColumn,
} from 'typeorm';
import { JobApplication } from './job-application.entity';

@Entity('jobs')
export class Job {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer!: User;

  @RelationId((job: Job) => job.customer)
  customerId!: number;

  @ManyToOne(() => ServiceEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'service_id' })
  service!: ServiceEntity;

  @RelationId((job: Job) => job.service)
  serviceId!: number;

  @Column({ type: 'text', nullable: true })
  title?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column()
  location!: string;

  @Column({ name: 'budget_min', type: 'decimal', precision: 10, scale: 2, nullable: true })
  budgetMin?: number;

  @Column({ name: 'budget_max', type: 'decimal', precision: 10, scale: 2, nullable: true })
  budgetMax?: number;

  /** ISO 4217 currency code for budgetMin / budgetMax (e.g. "GHS", "USD", "EUR"). */
  @Column({ name: 'currency', type: 'varchar', length: 3, default: 'GHS' })
  currency!: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  latitude?: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  longitude?: number;

  @Column({ type: 'enum', enum: Status, default: Status.OPEN })
  status!: Status;

  /** Set when the customer accepts an artisan's application. */
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'accepted_artisan_id' })
  acceptedArtisan?: User;

  @RelationId((job: Job) => job.acceptedArtisan)
  acceptedArtisanId?: number;

  /** Opaque payment-provider intent ID; set when the payment hold is placed. */
  @Column({ name: 'payment_intent_id', type: 'varchar', nullable: true })
  paymentIntentId?: string;

  /** Set when the accepted artisan signals the work is done and awaits customer confirmation. */
  @Column({ name: 'completion_requested_at', type: 'timestamp', nullable: true })
  completionRequestedAt?: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt!: Date;

  /** Populated by soft-delete; TypeORM automatically excludes rows where this is non-null. */
  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamp', nullable: true })
  deletedAt?: Date;
}
