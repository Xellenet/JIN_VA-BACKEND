
import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn, DeleteDateColumn, OneToMany } from "typeorm";
import { Address } from "./address.entity";
import { Gender, Role } from "@common/types/enums";
import { Exclude } from "class-transformer";
import { UserToken } from "./user-token.entity";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({unique: true})
  @Index()
  email: string;

  @Column({select: false})
  @Exclude()
  password: string;

  @Column({nullable: true})
  username: string;

  @Column({ name: 'date_of_birth', type: 'date', nullable: true})
  dateOfBirth: Date;

  @Column()
  firstname: string;

  @Column()
  lastname: string;

  @Column({name: 'phone_number', unique: true, nullable: true})
  phoneNumber: string;

  @Column({name: 'verified_at', nullable: true})
  verifiedAt: Date;

  @Column({name: 'account_verified', nullable: true})
  accountVerified: boolean;

  @Column({
    type: 'enum',
    enum: Gender
  })
  gender: Gender


  @Column({
    type: 'enum',
    enum: Role,
    default: Role.CUSTOMER
  })
  role: Role

  @Column({name: 'profile_picture', nullable: true})
  profilePicture: string;

  @Column({name: 'social_provider', nullable: true})
  socialProvider: string;

  @Column({name: 'social_provider_id', nullable: true})
  socialProviderId: string;

  @Column({name: 'is_social_login', default: false})
  isSocialLogin: boolean;

  @OneToMany(() => Address, (address) => address.user, { cascade: true })
  addresses: Address[];

  @OneToMany(() => UserToken, (token) => token.user, { cascade: true })
  tokens: UserToken[];

  @CreateDateColumn({name: 'created_at', type: 'timestamp'})
  @Exclude()
  createdAt: Date;

  @UpdateDateColumn({name: 'updated_at', type: 'timestamp'})
  @Exclude()
  updatedAt: Date;


  @DeleteDateColumn({name: 'deleted_at', type: 'timestamp', nullable: true})
  @Exclude()
  deletedAt?: Date;


}
