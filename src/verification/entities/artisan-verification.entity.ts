import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DocumentType, VerificationStatus } from '@common/types/enums';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { User } from '@users/entities/user.entity';

@Entity('artisan_verifications')
export class ArtisanVerification {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => ArtisanProfile, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'artisan_profile_id' })
  artisanProfile!: ArtisanProfile;

  @Column({ name: 'artisan_profile_id' })
  artisanProfileId!: number;

  @Column({ name: 'document_type', type: 'varchar', length: 50 })
  documentType!: DocumentType;

  @Column({ name: 'id_number', type: 'varchar', length: 100, nullable: true })
  idNumber?: string;

  @Column({ name: 'full_legal_name', type: 'varchar', length: 200, nullable: true })
  fullLegalName?: string;

  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth?: string;

  @Column({ name: 'document_front_url', type: 'text' })
  documentFrontUrl!: string;

  @Column({ name: 'document_back_url', type: 'text', nullable: true })
  documentBackUrl?: string;

  @Column({ name: 'selfie_url', type: 'text' })
  selfieUrl!: string;

  @Column({ name: 'additional_notes', type: 'text', nullable: true })
  additionalNotes?: string;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 20,
    default: VerificationStatus.PENDING,
  })
  status!: VerificationStatus;

  @Column({ name: 'provider', type: 'varchar', length: 50, default: 'manual' })
  provider!: string;

  @Column({ name: 'provider_reference', type: 'varchar', length: 200, nullable: true })
  providerReference?: string;

  @Column({ name: 'provider_raw_response', type: 'jsonb', nullable: true })
  providerRawResponse?: Record<string, unknown>;

  @Column({ name: 'admin_notes', type: 'text', nullable: true })
  adminNotes?: string;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reviewed_by_id' })
  reviewedBy?: User;

  @Column({ name: 'reviewed_by_id', nullable: true })
  reviewedById?: number;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
