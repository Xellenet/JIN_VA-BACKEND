import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
  OneToOne,
} from 'typeorm';
import { Address } from './address.entity';
import { Gender, Role } from '@common/types/enums';
import { Exclude } from 'class-transformer';
import { UserToken } from './user-token.entity';
import { ArtisanProfile } from './artisan-profile.entity';
import { CustomerProfile } from './customer-profile.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  @Index()
  email: string;

  // G5: nullable — brand-new Google signups have no password to set. `null`
  // here is also the G10 signal that this account has no usable password and
  // must never reach `bcrypt.compare`; it stops being null the moment the
  // user sets a real password (change-password, or forgot/reset-password).
  @Column({ type: 'varchar', select: false, nullable: true })
  @Exclude()
  password: string | null;

  @Column({ nullable: true })
  username: string;

  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth: Date;

  @Column()
  firstname: string;

  @Column()
  lastname: string;

  @Column({ name: 'phone_number', unique: true, nullable: true })
  phoneNumber: string;

  @Column({ name: 'verified_at', nullable: true })
  verifiedAt: Date;

  @Column({ name: 'account_verified', nullable: true })
  accountVerified: boolean;

  // G5: nullable (fixed decision) — Google never supplies gender, and gating
  // one-click Google signup on collecting it would defeat the point.
  @Column({
    type: 'enum',
    enum: Gender,
    nullable: true,
  })
  gender: Gender | null;

  @Column({
    type: 'enum',
    enum: Role,
    default: Role.CUSTOMER,
  })
  role: Role;

  @Column({ name: 'profile_picture', nullable: true })
  profilePicture: string;

  @Column({ name: 'social_provider', nullable: true })
  socialProvider: string;

  @Column({ name: 'social_provider_id', nullable: true })
  socialProviderId: string;

  @Column({ name: 'is_social_login', default: false })
  isSocialLogin: boolean;

  @Column({ name: 'is_banned', type: 'boolean', default: false })
  isBanned!: boolean;

  @Column({ name: 'banned_at', type: 'timestamp', nullable: true })
  bannedAt?: Date;

  /** AT2: the admin who applied the ban. Nothing recorded an actor before. */
  @Column({ name: 'banned_by_id', type: 'int', nullable: true })
  bannedById?: number;

  /**
   * AT3: reversible suspension, distinct from the permanent ban (Open
   * Question 4, resolved): a suspended user **can** still log in, but cannot
   * transact (no new bookings, jobs, applications or messages) and is not
   * publicly discoverable in artisan search. Indefinite until an admin
   * reactivates.
   *
   * Deliberately independent of `isBanned` rather than a single status enum —
   * the two can coexist and `isBanned` already gates login in `JwtStrategy`.
   */
  @Column({ name: 'is_suspended', type: 'boolean', default: false })
  isSuspended!: boolean;

  @Column({ name: 'suspended_at', type: 'timestamp', nullable: true })
  suspendedAt?: Date;

  @Column({ name: 'suspended_by_id', type: 'int', nullable: true })
  suspendedById?: number;

  /** AT3: the reason an admin gave; shown to the admin, not to the user. */
  @Column({ name: 'suspension_reason', type: 'text', nullable: true })
  suspensionReason?: string;

  @OneToMany(() => Address, (address) => address.user, { cascade: true })
  addresses: Address[];

  @OneToMany(() => UserToken, (token) => token.user, { cascade: true })
  tokens: UserToken[];

  @OneToOne(() => ArtisanProfile, (artisanProfile) => artisanProfile.user)
  artisanProfile?: ArtisanProfile;

  @OneToOne(() => CustomerProfile, (customerProfile) => customerProfile.user)
  customerProfile?: CustomerProfile;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  @Exclude()
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  @Exclude()
  updatedAt: Date;

  @DeleteDateColumn({ name: 'deleted_at', type: 'timestamp', nullable: true })
  @Exclude()
  deletedAt?: Date;

  /**
   * C1.7/C1.8: stamped by the scheduled purge job once the 30-day recovery
   * window has elapsed and this row's personal data has been irreversibly
   * scrubbed. `deletedAt` stays set alongside it.
   *
   * This is what makes "restore after purge" impossible **by construction**
   * rather than merely unexposed: every restore path refuses outright on a
   * non-null `purgedAt`, the purge candidate query skips rows that already
   * have one (making reruns idempotent), and the soft-deleted-account lookup
   * used by login excludes them, so a purged account is indistinguishable
   * from one that never existed. The scrubbed email and nulled password hash
   * are the other two independent guarantees — see `AccountPurgeService`.
   */
  @Column({ name: 'purged_at', type: 'timestamp', nullable: true })
  @Exclude()
  purgedAt?: Date | null;
}
