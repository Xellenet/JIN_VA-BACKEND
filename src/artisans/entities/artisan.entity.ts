import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  JoinTable,
  ManyToMany,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '@users/entities/user.entity';
import { Address } from '@users/entities/address.entity';
import { ArtisanPortfolioImage } from './artisan-portfolio-image.entity';
import { ServiceEntity } from '../../services/entities/service.entity';

@Entity('artisans')
export class Artisan {
  @PrimaryGeneratedColumn()
  id: number;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'contact_phone', nullable: true })
  contactPhone?: string;

  @Column({ name: 'contact_email', nullable: true })
  contactEmail?: string;

  @OneToOne(() => Address, { nullable: true, eager: true })
  @JoinColumn({ name: 'location_address_id' })
  locationAddress?: Address;

  @Column({ name: 'average_rating', type: 'decimal', precision: 3, scale: 2, default: 0 })
  averageRating: number;

  @Column({ name: 'total_ratings', default: 0 })
  totalRatings: number;

  @Column({ type: 'text', nullable: true })
  bio?: string;

  @Column({ name: 'years_of_experience', nullable: true })
  yearsOfExperience?: number;

  @Column({ name: 'certifications', type: 'simple-array', nullable: true })
  certifications?: string[];

  @Column({ name: 'license_number', nullable: true })
  licenseNumber?: string;

  @Column({ name: 'specializations', type: 'simple-array', nullable: true })
  specializations?: string[];

  @ManyToMany(() => ServiceEntity, (service) => service.artisans)
  @JoinTable({
    name: 'artisan_services',
    joinColumn: { name: 'artisan_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'service_id', referencedColumnName: 'id' },
  })
  services: ServiceEntity[];

  @OneToMany(() => ArtisanPortfolioImage, (image) => image.artisan, { cascade: true })
  portfolioImages: ArtisanPortfolioImage[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt: Date;
}
