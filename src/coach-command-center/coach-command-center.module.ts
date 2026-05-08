import { Module, forwardRef } from '@nestjs/common';
import { CoachCommandCenterController } from './coach-command-center.controller';
import { CoachCommandCenterService } from './coach-command-center.service';
import { AuthModule } from '../auth/auth.module';
import { AdminModule } from '../admin/admin.module';

/**
 * CoachCommandCenterModule — Phase 8.
 *
 * Provides the unified coach dashboard surface under /coach/command-center/*.
 * All risk math is delegated to AdminPtmService (from AdminModule); this
 * module owns only the aggregation and inbox/action-queue queries.
 *
 * AdminModule is imported with forwardRef() because CoachModule (imported
 * by AdminModule) already holds the circular ref; this module needs the same
 * guard to avoid a "circular dependency detected" boot error.
 */
@Module({
  imports: [AuthModule, forwardRef(() => AdminModule)],
  controllers: [CoachCommandCenterController],
  providers: [CoachCommandCenterService],
  exports: [CoachCommandCenterService],
})
export class CoachCommandCenterModule {}
