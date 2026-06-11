import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { PlanContextController } from './plan-context.controller';
import { PlanContextService } from './plan-context.service';
import { PlanContextRepository } from './plan-context.repository';

/**
 * v2-1 plan-context tags.
 *
 * Bundles the read-only resolve surface and exports PlanContextService so the
 * messages module can validate a tag on send. PrismaService is provided
 * globally via PrismaModule; AuthModule supplies JwtAuthGuard's dependencies
 * for the controller guard chain (mirrors the messages controller wiring).
 */
@Module({
  imports: [AuthModule],
  controllers: [PlanContextController],
  providers: [PlanContextService, PlanContextRepository],
  exports: [PlanContextService],
})
export class PlanContextModule {}
