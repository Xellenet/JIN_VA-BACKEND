import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn, JoinColumn } from 'typeorm';
import { User } from './user.entity';
import { Token } from '@common/types/enums';

@Entity('user_tokens')
export class UserToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, user => user.tokens, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: Token })
  type: Token;

  @Column({type: 'text'})
  token: string;

  @Column({name: 'expires_at', type: 'timestamp' })
  expiresAt: Date;

  @CreateDateColumn({name: 'created_at', type: 'timestamp'})
  createdAt: Date;
}
