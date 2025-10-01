import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({unique: true})
  email: string;

  @Column({select: false})
  password: string;

  @Column()
  username: string;

  @Column()
  age: number;

  @Column()
  firstname: string

  @Column()
  lastname: string
}
