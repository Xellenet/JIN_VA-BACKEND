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
import { BookingStatus } from '@common/types/enums';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { ArtisanAvailability } from '../../availability/entities/artisan-availability.entity';

@Entity('bookings')
export class Booking {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer!: User;

  @RelationId((b: Booking) => b.customer)
  customerId!: number;

  @ManyToOne(() => ArtisanProfile, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'artisan_profile_id' })
  artisanProfile!: ArtisanProfile;

  @RelationId((b: Booking) => b.artisanProfile)
  artisanProfileId!: number;

  @ManyToOne(() => ArtisanAvailability, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'availability_slot_id' })
  availabilitySlot?: ArtisanAvailability;

  @Column({ name: 'availability_slot_id', nullable: true })
  availabilitySlotId?: number;

  /** The specific calendar date requested (YYYY-MM-DD) */
  @Column({ name: 'scheduled_date', type: 'date' })
  scheduledDate!: string;

  /** HH:MM start time copied from the availability slot (or provided by customer) */
  @Column({ name: 'start_time', type: 'time' })
  startTime!: string;

  /** HH:MM end time copied from the availability slot (or provided by customer) */
  @Column({ name: 'end_time', type: 'time' })
  endTime!: string;

  @Column({ type: 'varchar', length: 20, default: BookingStatus.PENDING })
  status!: BookingStatus;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ name: 'artisan_notes', type: 'text', nullable: true })
  artisanNotes?: string;

  /** Agreed service price quoted at booking time */
  @Column({ name: 'agreed_price', type: 'decimal', precision: 10, scale: 2, nullable: true })
  agreedPrice?: number;

  /** ISO 4217 currency code for agreedPrice */
  @Column({ name: 'currency', type: 'varchar', length: 3, default: 'GHS' })
  currency!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
