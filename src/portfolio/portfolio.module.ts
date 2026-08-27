import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PortfolioController } from './portfolio.controller';
import { PortfolioService } from './portfolio.service';
import { PortfolioItem } from './entities/portfolio-item.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { UploadsModule } from '../uploads/uploads.module';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([PortfolioItem, ArtisanProfile]),
    UploadsModule,
    // AT5: portfolio approve/reject each write an audit row.
    AdminAuditModule,
  ],
  controllers: [PortfolioController],
  providers: [PortfolioService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
