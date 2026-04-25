import { Module } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/auth.guard';
import { CoachGuard } from '../auth/coach.guard';
import { JwksVerifierService } from '../auth/jwks.service';
import { InviteCodesController } from './invite-codes.controller';
import { InviteCodesService } from './invite-codes.service';

// PrismaService and SupabaseService are provided globally (PrismaModule,
// SupabaseModule). JwtAuthGuard now depends on JwksVerifierService (PR #25
// switched auth to local JWKS verification) so we provide it locally too.
// Providing the guards locally avoids the circular import AuthModule ↔ InviteCodesModule
// that would otherwise arise from AuthService needing InviteCodesService.
@Module({
  controllers: [InviteCodesController],
  providers: [InviteCodesService, JwtAuthGuard, CoachGuard, JwksVerifierService],
  exports: [InviteCodesService],
})
export class InviteCodesModule {}
