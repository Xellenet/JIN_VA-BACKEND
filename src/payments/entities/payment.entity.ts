import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Job } from '@jobs/entities/job.entity';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { PaymentStatus } from '@common/types/enums';

@Entity('payments')
export class Payment {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Job, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job!: Job;

  @Column({ name: 'job_id' })
  jobId!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer!: User;

  @Column({ name: 'customer_id' })
  customerId!: number;

  @ManyToOne(() => ArtisanProfile, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'artisan_profile_id' })
  artisanProfile!: ArtisanProfile;

  @Column({ name: 'artisan_profile_id' })
  artisanProfileId!: number;

  /** Total amount the customer pays (GHS) */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount!: number;

  /** Platform commission deducted before artisan payout (GHS) */
  @Column({ name: 'platform_fee', type: 'decimal', precision: 10, scale: 2 })
  platformFee!: number;

  /** Amount transferred to artisan = amount − platformFee (GHS) */
  @Column({ name: 'artisan_amount', type: 'decimal', precision: 10, scale: 2 })
  artisanAmount!: number;

  @Column({ type: 'varchar', length: 3, default: 'GHS' })
  currency!: string;

  @Column({ type: 'varchar', length: 25, default: PaymentStatus.PENDING })
  status!: PaymentStatus;

  /** Reference we generated; also used as Paystack transaction reference */
  @Column({ unique: true, length: 100 })
  reference!: string;

  /** Authorization URL returned by Paystack for customer redirect */
  @Column({ name: 'authorization_url', type: 'text', nullable: true })
  authorizationUrl?: string;

  /** Paystack access code for inline JS popup */
  @Column({ name: 'access_code', nullable: true })
  accessCode?: string;

  /** Payment channel: 'card', 'mobile_money', 'bank' */
  @Column({ nullable: true })
  channel?: string;

  /** Reference for the outbound Transfer to artisan */
  @Column({ name: 'transfer_reference', nullable: true })
  transferReference?: string;

  /** Paystack transfer_code for tracking payout status */
  @Column({ name: 'transfer_code', nullable: true })
  transferCode?: string;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt?: Date;

  @Column({ name: 'released_at', type: 'timestamptz', nullable: true })
  releasedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
