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
  description?: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  price?: number;

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

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt!: Date;
}
