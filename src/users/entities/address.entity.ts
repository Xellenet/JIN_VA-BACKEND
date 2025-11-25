import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { User } from "./user.entity";

@Entity('addresses')
export class Address{
    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    street: string;

    @Column()
    city: string;

    @Column()
    country: string;

    @Column({name: 'zip_code'})
    zipCode: string;


    @ManyToOne(() => User, (user) => user.addresses, { onDelete: 'CASCADE'})
    @JoinColumn({ name: 'user_id' })
    user: User;

    @CreateDateColumn({name: 'created_at', type: 'timestamp'})
    createdAt: Date;

    @UpdateDateColumn({name: 'updated_at', type: 'timestamp'})
    updatedAt: Date;
}