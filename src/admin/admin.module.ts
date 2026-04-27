import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../auth/roles.guard';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { MetricsService } from './metrics.service';

// Phase 1A/1B platform admin module. AuthModule import wires
// JwtAuthGuard + JwksVerifierService into this module's DI scope so
// @UseGuards(JwtAuthGuard, RolesGuard) resolves locally.
@Module({
  imports: [AuthModule],
  controllers: [AdminController],
  providers: [AdminService, MetricsService, RolesGuard],
  exports: [AdminService, MetricsService],
})
export class AdminModule {}
