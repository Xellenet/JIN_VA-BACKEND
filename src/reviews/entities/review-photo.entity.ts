import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Review } from './review.entity';

/**
 * RP1: a photo attached to a review at creation time, uploaded beforehand
 * via `POST /uploads/review-photo` (existing storage-provider abstraction).
 * Max 3 per review, enforced in `ReviewsService.create` — not a DB
 * constraint, matching the equivalent `JobAttachment` precedent.
 */
@Entity('review_photos')
export class ReviewPhoto {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Review, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'review_id' })
  review!: Review;

  @Column({ name: 'review_id' })
  reviewId!: number;

  @Column({ name: 'url', type: 'varchar' })
  url!: string;

  @Column({ name: 'file_type', type: 'varchar', length: 100 })
  fileType!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;
}
