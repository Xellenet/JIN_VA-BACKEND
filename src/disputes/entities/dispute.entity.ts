import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DisputeStatus } from '@common/types/enums';
import { Booking } from '../../bookings/entities/booking.entity';
import { User } from '../../users/entities/user.entity';

@Entity('disputes')
export class Dispute {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Booking, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'booking_id' })
  booking!: Booking;

  @Column({ name: 'booking_id' })
  bookingId!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'raised_by_id' })
  raisedBy!: User;

  @Column({ name: 'raised_by_id' })
  raisedById!: number;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ name: 'status', type: 'varchar', length: 20, default: DisputeStatus.OPEN })
  status!: DisputeStatus;

  @Column({ name: 'admin_notes', type: 'text', nullable: true })
  adminNotes?: string;

  @Column({ name: 'resolution', type: 'text', nullable: true })
  resolution?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'resolved_by_id' })
  resolvedBy?: User;

  @Column({ name: 'resolved_by_id', nullable: true })
  resolvedById?: number;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
