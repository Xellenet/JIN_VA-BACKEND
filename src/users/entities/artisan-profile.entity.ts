import {
	Check,
	Column,
	CreateDateColumn,
	Entity,
	JoinColumn,
	JoinTable,
	ManyToMany,
	OneToOne,
	PrimaryGeneratedColumn,
	UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import { ServiceEntity } from '@services/entities/service.entity';

@Entity('artisan_profiles')
@Check(`"experience_years" IS NULL OR "experience_years" > 0`)
@Check(`"hourly_rate" IS NULL OR "hourly_rate" > 0`)
@Check(`"bio" IS NULL OR char_length("bio") <= 1000`)
export class ArtisanProfile {
	@PrimaryGeneratedColumn()
	id!: number;

	@OneToOne(() => User, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'user_id' })
	user!: User;

	@Column({ type: 'text', nullable: true })
	bio?: string;

	@Column({ name: 'experience_years', type: 'int', nullable: true })
	experienceYears?: number;

	@Column({ name: 'hourly_rate', type: 'decimal', precision: 10, scale: 2, nullable: true })
	hourlyRate?: number;

	@Column({ name: 'business_name', nullable: true })
	businessName?: string;

	@Column({ name: 'average_rating', type: 'decimal', precision: 3, scale: 2, default: 0 })
	averageRating!: number;

	@Column({ name: 'total_reviews', type: 'int', default: 0 })
	totalReviews!: number;

	@Column({ name: 'availability_status', default: 'AVAILABLE' })
	availabilityStatus!: string;

	@Column({ name: 'is_verified', type: 'boolean', default: false })
	isVerified!: boolean;

	@Column({ type: 'varchar', nullable: true })
	location?: string;

	@ManyToMany(() => ServiceEntity)
	@JoinTable({
		name: 'artisan_profile_services',
		joinColumn: { name: 'artisan_profile_id', referencedColumnName: 'id' },
		inverseJoinColumn: { name: 'service_id', referencedColumnName: 'id' },
	})
	services!: ServiceEntity[];

	@CreateDateColumn({ name: 'created_at', type: 'timestamp' })
	createdAt!: Date;

	@UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
	updatedAt!: Date;
}
