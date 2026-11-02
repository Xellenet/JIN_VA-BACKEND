import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('services')
export class ServiceEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  price?: number | null;

  /**
   * A2: how long this service typically takes, in minutes. Used to derive a
   * booking's `endTime` (`startTime + estimatedDurationMins`) when the
   * customer/frontend doesn't supply one explicitly. Backfilled to the
   * platform default (see `VARIABLES.DEFAULT_SERVICE_DURATION_MINS`) for
   * rows that predate this column.
   */
  @Column({
    name: 'estimated_duration_mins',
    type: 'int',
    default: 60,
  })
  estimatedDurationMins!: number;

  /**
   * Hidden services (false) leave the public catalogue: customers can't post
   * jobs or bookings for them and artisans can't add them, but existing
   * records keep them. This is how an admin retires a service that is in
   * use, since deleting it would break those records.
   */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt!: Date;
}
