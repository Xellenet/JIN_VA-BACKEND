import { Status } from "@common/types/enums";
import { ServiceEntity } from "@services/entities/service.entity";
import { User } from "@users/entities/user.entity";
import {
    Column,
    CreateDateColumn,
    Entity,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    RelationId,
    UpdateDateColumn,
} from "typeorm";

@Entity('jobs')
export class Job {
    @PrimaryGeneratedColumn()
    id!: number;

    @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'customer_id' })
    customer!: User;

    @RelationId((job: Job) => job.customer)
    customerId!: number;

    @ManyToOne(() => ServiceEntity, { nullable: false, onDelete: 'RESTRICT' })
    @JoinColumn({ name: 'service_id' })
    service!: ServiceEntity;

    @RelationId((job: Job) => job.service)
    serviceId!: number;

    @Column({type: 'text', nullable: true})
    description?: string;

    @Column({type: 'text', nullable: true})
    title!: string;

    @Column({type: 'decimal', precision: 10, scale: 2, nullable: true})
    budgetMin?: number;

    @Column({type: 'decimal', precision: 10, scale: 2, nullable: true})
    budgetMax?: number;

    @Column()
    location!: string;

    @Column({type: 'decimal', precision: 10, scale: 2, nullable: true})
    latitude?: number;

    @Column({type: 'decimal', precision: 10, scale: 2, nullable: true})
    longitude?: number;

    @Column({type: 'enum', enum: Status, default: Status.OPEN})
    status!: Status;

    @CreateDateColumn({name: 'created_at', type: 'timestamp'})
    createdAt!: Date;
    
    @UpdateDateColumn({name: 'updated_at', type: 'timestamp'})
    updatedAt!: Date;

    @Column({name: 'deleted_at', type: 'timestamp', nullable: true})
    deletedAt?: Date;
}
