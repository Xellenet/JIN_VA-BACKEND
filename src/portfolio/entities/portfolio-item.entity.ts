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
import { PortfolioStatus } from '@common/types/enums';

/**
 * PF1: an artisan's uploaded photo/video showcasing past work, subject to
 * admin moderation before it appears on the artisan's public profile gallery.
 *
 * `artisanId` refers to the `ArtisanProfile` primary key — the same identifier
 * used throughout the rest of the API (e.g. `GET /artisans/:id`), not the
 * underlying `User` id.
 */
@Entity('portfolio_items')
export class PortfolioItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => ArtisanProfile, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'artisan_id' })
  artisanProfile!: ArtisanProfile;

  @Column({ name: 'artisan_id' })
  artisanId!: number;

  @Column({ name: 'file_url', type: 'text' })
  fileUrl!: string;

  /** MIME type of the stored file, e.g. `image/jpeg`, `image/png`, `video/mp4`. */
  @Column({ name: 'file_type', type: 'varchar', length: 100 })
  fileType!: string;

  @Column({ type: 'text', nullable: true })
  caption?: string;

  /** Service category tag the artisan associates with this piece of work. */
  @Column({ type: 'varchar', length: 100, nullable: true })
  tag?: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: PortfolioStatus.PENDING,
  })
  status!: PortfolioStatus;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason?: string | null;

  /** PF1/PF7: artisan-controlled display order within their own gallery. */
  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
