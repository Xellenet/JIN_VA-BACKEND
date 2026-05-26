import {
  Column,
  Entity,
  JoinColumn,
  ManyToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Address } from './address.entity';
import { ServiceEntity } from '../../services/entities/service.entity';

@Entity('artisans')
export class Artisan {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'contact_phone', nullable: true })
  contactPhone?: string;

  @Column({ name: 'contact_email', nullable: true })
  contactEmail?: string;

  @OneToOne(() => Address, { nullable: true, eager: true })
  @JoinColumn({ name: 'location_address_id' })
  locationAddress?: Address;

  @Column({ name: 'average_rating', type: 'decimal', precision: 3, scale: 2, default: 0 })
  averageRating!: number;

  @Column({ name: 'total_ratings', default: 0 })
  totalRatings!: number;

  @ManyToMany(() => ServiceEntity, (service) => service.artisans)
  services!: ServiceEntity[];
}
