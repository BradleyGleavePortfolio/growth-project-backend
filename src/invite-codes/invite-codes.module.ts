import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { InviteCodesController } from './invite-codes.controller';
import { InviteCodesService } from './invite-codes.service';

// PrismaService and SupabaseService are provided globally (PrismaModule,
// SupabaseModule), so JwtAuthGuard's deps resolve without importing AuthModule.
// Providing the guards locally avoids the circular import AuthModule ↔ InviteCodesModule
// that would otherwise arise from AuthService needing InviteCodesService.
@Module({
  controllers: [InviteCodesController],
  providers: [InviteCodesService, JwtAuthGuard, CoachGuard],
  exports: [InviteCodesService],
})
export class InviteCodesModule {}
