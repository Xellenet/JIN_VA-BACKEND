import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';

@Entity('artisan_availability')
export class ArtisanAvailability {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => ArtisanProfile, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'artisan_profile_id' })
  artisanProfile!: ArtisanProfile;

  @Column({ name: 'artisan_profile_id' })
  artisanProfileId!: number;

  /** 0 = Sunday, 1 = Monday, …, 6 = Saturday */
  @Column({ name: 'day_of_week', type: 'smallint' })
  dayOfWeek!: number;

  /** HH:MM 24-hour format */
  @Column({ name: 'start_time', type: 'time' })
  startTime!: string;

  /** HH:MM 24-hour format */
  @Column({ name: 'end_time', type: 'time' })
  endTime!: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt!: Date;
}
