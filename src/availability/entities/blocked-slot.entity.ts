import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';

/**
 * A1: an artisan-declared date range (inclusive, whole calendar days) during
 * which they are unavailable — a holiday, time off, etc. Stored as plain
 * `date` columns (no time-of-day component), so DST has no effect on which
 * dates are blocked (see A1 edge cases in requirements.md).
 */
@Entity('blocked_slots')
export class BlockedSlot {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => ArtisanProfile, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'artisan_profile_id' })
  artisanProfile!: ArtisanProfile;

  @Column({ name: 'artisan_profile_id' })
  artisanProfileId!: number;

  @Column({ name: 'start_date', type: 'date' })
  startDate!: string;

  @Column({ name: 'end_date', type: 'date' })
  endDate!: string;

  @Column({ type: 'text', nullable: true })
  reason?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;
}
