import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { User } from '@users/entities/user.entity';
import { Job } from '@jobs/entities/job.entity';
import { ReviewStatus } from '@common/types/enums';
import { ReviewPhoto } from './review-photo.entity';

@Entity('reviews')
export class Review {
  @PrimaryGeneratedColumn()
  id!: number;

  /**
   * The completed job this review is tied to. Unique at the DB level via
   * the partial unique index `UQ_reviews_job_id` (added by
   * `AddReviewJobEnforcement1781800000000`, predates this feature) — one
   * review per job.
   */
  @ManyToOne(() => Job, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job!: Job;

  @ManyToOne(() => ArtisanProfile, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'artisan_profile_id' })
  artisanProfile!: ArtisanProfile;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reviewer_user_id' })
  reviewerUser?: User;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'reviewed_user_id' })
  reviewedUser!: User;

  @Column({ name: 'reviewer_name', nullable: true })
  reviewerName?: string;

  @Column({ type: 'decimal', precision: 3, scale: 2 })
  rating!: number;

  @Column({ type: 'text', nullable: true })
  review?: string;

  /**
   * AM1: moderation status. `REMOVED` is never actually persisted — see
   * {@link ReviewStatus}. Public read endpoints filter `FLAGGED` rows out
   * for everyone except the original reviewer (FL1); admin endpoints see
   * every status.
   */
  @Column({
    type: 'varchar',
    length: 20,
    default: ReviewStatus.ACTIVE,
  })
  status!: ReviewStatus;

  /**
   * RE1: set the moment the original reviewer edits within the 48h window.
   * Kept distinct from `updatedAt` (which also bumps on flag/reply/restore)
   * so the frontend can show an "Edited" badge precisely when — and only
   * when — the review text/rating itself changed.
   */
  @Column({ name: 'edited_at', type: 'timestamp', nullable: true })
  editedAt?: Date | null;

  /** AR1: the reviewed artisan's one-time public reply. Null until posted. */
  @Column({ name: 'artisan_reply', type: 'text', nullable: true })
  artisanReply?: string | null;

  @Column({ name: 'artisan_replied_at', type: 'timestamp', nullable: true })
  artisanRepliedAt?: Date | null;

  /** RP1: up to 3 photos, enforced in `ReviewsService`, not at the DB level. */
  @OneToMany(() => ReviewPhoto, (photo) => photo.review, { cascade: false })
  photos?: ReviewPhoto[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt!: Date;
}
