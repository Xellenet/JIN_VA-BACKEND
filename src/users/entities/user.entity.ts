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
}
