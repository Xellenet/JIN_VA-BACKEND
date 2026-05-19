import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Artisan } from './artisan.entity';

@Entity('artisan_portfolio_images')
export class ArtisanPortfolioImage {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => Artisan, (artisan) => artisan.portfolioImages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'artisan_id' })
  artisan: Artisan;

  @Column({ name: 'image_url', type: 'text' })
  imageUrl: string;

  @Column({ nullable: true })
  caption?: string;

  @Column({ name: 'display_order', default: 0 })
  displayOrder: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;
}
