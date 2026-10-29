import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminAction } from './entities/admin-action.entity';
import { AdminAuditService } from './admin-audit.service';

/**
 * AT5: deliberately a leaf module with no dependencies beyond its own
 * repository, so `AdminModule`, `DisputesModule`, `PaymentsModule`,
 * `PortfolioModule` and `VerificationModule` can all import it without
 * creating a cycle (`AdminModule` already imports most of them).
 *
 * The log's read endpoint lives on `AdminController` (`GET /admin/actions`)
 * because it is admin-only and belongs with the rest of the admin surface;
 * this module owns only the write path and the query.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AdminAction])],
  providers: [AdminAuditService],
  exports: [AdminAuditService],
})
export class AdminAuditModule {}
