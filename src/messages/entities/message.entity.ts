import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '@users/entities/user.entity';
import { Job } from '@jobs/entities/job.entity';
import { Booking } from '../../bookings/entities/booking.entity';
import { Conversation } from './conversation.entity';

@Entity('messages')
export class Message {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Conversation, (conversation) => conversation.messages, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'conversation_id' })
  conversation!: Conversation;

  @Column({ name: 'conversation_id' })
  conversationId!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sender_id' })
  sender!: User;

  @Column({ name: 'sender_id' })
  senderId!: number;

  /**
   * MC4: nullable since a message may carry an image with no accompanying
   * text. Still 1–2000 characters whenever it *is* present (MC3) — the length
   * bound is unchanged from before consolidation, only its optionality moved.
   * `SendMessageDto`/`MessagesService.send` reject a message that has neither
   * text nor an attachment.
   */
  @Column({ type: 'text', nullable: true })
  content!: string | null;

  /**
   * MC4: URL of the single attached image, pre-uploaded via
   * `POST /uploads/message-attachment`. Stored inline rather than in a child
   * table because the design spec scopes messages to exactly one attachment
   * (unlike `review_photos`, which needed up to three per review) — sending
   * several images means sending several messages.
   */
  @Column({ name: 'attachment_url', type: 'varchar', nullable: true })
  attachmentUrl!: string | null;

  /** MC4: display MIME type of {@link attachmentUrl} (`image/jpeg`/`image/png`). */
  @Column({
    name: 'attachment_type',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  attachmentType!: string | null;

  /**
   * MC2: the job this message was sent *about*, when it was composed from a
   * job's detail page. Pure metadata riding on the existing persistent
   * one-thread-per-user-pair model — it does NOT scope the thread to the job,
   * does not create a thread per job, and does not archive anything. A general
   * inquiry from an artisan's profile or the favourites list leaves it null,
   * which must keep working exactly as before.
   */
  @ManyToOne(() => Job, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'job_id' })
  job!: Job | null;

  @Column({ name: 'job_id', nullable: true })
  jobId!: number | null;

  /** MC2: the booking equivalent of {@link job}. Mutually exclusive with it. */
  @ManyToOne(() => Booking, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'booking_id' })
  booking!: Booking | null;

  @Column({ name: 'booking_id', nullable: true })
  bookingId!: number | null;

  @Index()
  @Column({ name: 'is_read', type: 'boolean', default: false })
  isRead!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;
}
