import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '@users/entities/user.entity';

@Entity('notification_preferences')
export class NotificationPreferences {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  // ─── Notification channels (both roles) ──────────────────────────────────
  @Column({ name: 'email_enabled', type: 'boolean', default: true })
  emailEnabled!: boolean;

  @Column({ name: 'sms_enabled', type: 'boolean', default: false })
  smsEnabled!: boolean;

  @Column({ name: 'push_enabled', type: 'boolean', default: true })
  pushEnabled!: boolean;

  // ─── Customer notification types ──────────────────────────────────────────
  /** Artisan applied to a customer's job */
  @Column({ name: 'booking_confirmations', type: 'boolean', default: true })
  bookingConfirmations!: boolean;

  /** Job moved to IN_PROGRESS or completion was requested */
  @Column({ name: 'job_status_updates', type: 'boolean', default: true })
  jobStatusUpdates!: boolean;

  /** Receipts for completed payments */
  @Column({ name: 'payment_receipts', type: 'boolean', default: true })
  paymentReceipts!: boolean;

  /** Platform discounts and special offers */
  @Column({ name: 'promotional_offers', type: 'boolean', default: false })
  promotionalOffers!: boolean;

  /** Reminders for upcoming scheduled services */
  @Column({ name: 'service_reminders', type: 'boolean', default: true })
  serviceReminders!: boolean;

  /** Post-completion prompts to review an artisan */
  @Column({ name: 'review_requests', type: 'boolean', default: true })
  reviewRequests!: boolean;

  /** Customer's own job posting expired without being filled */
  @Column({ name: 'job_expired', type: 'boolean', default: true })
  jobExpired!: boolean;

  // ─── Artisan notification types ───────────────────────────────────────────
  /** New job postings matching the artisan's services */
  @Column({ name: 'new_job_opportunities', type: 'boolean', default: true })
  newJobOpportunities!: boolean;

  /** Application accepted or rejected by a customer */
  @Column({ name: 'application_updates', type: 'boolean', default: true })
  applicationUpdates!: boolean;

  /** Job cancelled or other artisan-relevant status changes */
  @Column({ name: 'artisan_job_updates', type: 'boolean', default: true })
  artisanJobUpdates!: boolean;

  /** Payment released after job completion is confirmed */
  @Column({ name: 'payment_released', type: 'boolean', default: true })
  paymentReleased!: boolean;

  /** New review or rating received */
  @Column({ name: 'reviews_and_ratings', type: 'boolean', default: true })
  reviewsAndRatings!: boolean;

  /** Platform promotions targeted at artisans */
  @Column({ name: 'artisan_promotions', type: 'boolean', default: false })
  artisanPromotions!: boolean;

  /** Application was not selected — another artisan was chosen */
  @Column({ name: 'application_rejected', type: 'boolean', default: true })
  applicationRejected!: boolean;

  /** A job the artisan applied to expired before being filled */
  @Column({ name: 'applied_job_expired', type: 'boolean', default: true })
  appliedJobExpired!: boolean;

  /** Artisan's platform profile was verified by an admin */
  @Column({ name: 'profile_verified', type: 'boolean', default: true })
  profileVerified!: boolean;

  // ─── Shared ───────────────────────────────────────────────────────────────
  @Column({ name: 'message_received', type: 'boolean', default: true })
  messageReceived!: boolean;
}
