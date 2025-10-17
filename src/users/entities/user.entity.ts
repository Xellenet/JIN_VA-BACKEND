
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

  @Column({type: 'date', nullable: true})
  dateOfBirth: Date;

  @Column()
  firstname: string;

  @Column()
  lastname: string;

  @Column({unique: true, nullable: true})
  phoneNumber: string;

  @Column({nullable: true})
  verifiedAt: Date;

  @Column({nullable: true})
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

  @Column({nullable: true})
  profilePicture: string;

  @Column({nullable: true})
  socialProvider: string;

  @Column({nullable: true})
  socialProviderId: string;

  @Column({default: false})
  isSocialLogin: boolean;

  @OneToMany(() => Address, (address) => address.user, { cascade: true })
  addresses: Address[];

  @OneToMany(() => UserToken, (token) => token.user, { cascade: true })
  tokens: UserToken[];

  @CreateDateColumn({type: 'timestamp'})
  @Exclude()
  createdAt: Date;

  @UpdateDateColumn({type: 'timestamp'})
  @Exclude()
  updatedAt: Date;


  @DeleteDateColumn({type: 'timestamp', nullable: true})
  @Exclude()
  deletedAt?: Date;


}
