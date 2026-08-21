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
import { ServiceEntity } from '@services/entities/service.entity';
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

  @ManyToOne(() => ArtisanAvailability, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'availability_slot_id' })
  availabilitySlot?: ArtisanAvailability;

  @Column({ name: 'availability_slot_id', nullable: true })
  availabilitySlotId?: number;

  /**
   * R2: the catalog service being booked. Nullable at the DB level for
   * backward compatibility with any pre-existing rows, but required on new
   * bookings by `CreateBookingDto` — needed to compute `endTime` from
   * `Service.estimatedDurationMins` (A2) and to populate the linked `Job`
   * created on confirmation.
   */
  @ManyToOne(() => ServiceEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'service_id' })
  service?: ServiceEntity;

  @RelationId((b: Booking) => b.service)
  serviceId?: number;

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
  @Column({
    name: 'agreed_price',
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
  })
  agreedPrice?: number;

  /** ISO 4217 currency code for agreedPrice */
  @Column({ name: 'currency', type: 'varchar', length: 3, default: 'GHS' })
  currency!: string;

  /**
   * J4: photo URLs collected at booking-request time (via the storage
   * provider abstraction), copied onto the linked `Job`'s attachments when
   * R2 creates it on confirmation.
   */
  @Column({ name: 'attachment_urls', type: 'jsonb', nullable: true })
  attachmentUrls?: string[];

  // ─── A6: no-show flags — both may independently coexist ──────────────────
  @Column({
    name: 'no_show_by_customer_at',
    type: 'timestamptz',
    nullable: true,
  })
  noShowByCustomerAt?: Date;

  @Column({
    name: 'no_show_by_artisan_at',
    type: 'timestamptz',
    nullable: true,
  })
  noShowByArtisanAt?: Date;

  // ─── A7: reminder idempotency flags ───────────────────────────────────────
  @Column({ name: 'reminder_24h_sent_at', type: 'timestamptz', nullable: true })
  reminder24hSentAt?: Date;

  @Column({ name: 'reminder_2h_sent_at', type: 'timestamptz', nullable: true })
  reminder2hSentAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
