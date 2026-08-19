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

@Entity('customer_profiles')
@Check(`"bio" IS NULL OR char_length("bio") <= 1000`)
@Check(`"budget_min" IS NULL OR "budget_min" > 0`)
@Check(`"budget_max" IS NULL OR "budget_max" > 0`)
@Check(`"budget_min" IS NULL OR "budget_max" IS NULL OR "budget_max" >= "budget_min"`)
export class CustomerProfile {
    @PrimaryGeneratedColumn()
    id!: number;

    @OneToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'user_id' })
    user!: User;

    @Column({ type: 'text', nullable: true })
    bio?: string;

    @ManyToMany(() => ServiceEntity)
    @JoinTable({
        name: 'customer_profile_services',
        joinColumn: { name: 'customer_profile_id', referencedColumnName: 'id' },
        inverseJoinColumn: { name: 'service_id', referencedColumnName: 'id' },
    })
    preferredServices!: ServiceEntity[];

    @Column({ name: 'budget_min', type: 'decimal', precision: 10, scale: 2, nullable: true })
    budgetMin?: number;

    @Column({ name: 'budget_max', type: 'decimal', precision: 10, scale: 2, nullable: true })
    budgetMax?: number;

    @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
    updatedAt!: Date;
}