import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { InviteCodesController } from './invite-codes.controller';
import { InviteCodesService } from './invite-codes.service';

// PrismaService and SupabaseService are provided globally. Guards
// (JwtAuthGuard, CoachGuard) and JwksVerifierService are provided by the
// @Global SecurityGuardsModule — InviteCodesModule does NOT import AuthModule
// (that would re-open the AuthModule ↔ InviteCodesModule cycle that
// AuthService → InviteCodesService closes on the runtime side).
//
// BillingModule is imported so the invite-code controller can read coach
// subscription state when redeeming a coach invite.
@Module({
  imports: [BillingModule],
  controllers: [InviteCodesController],
  providers: [InviteCodesService],
  exports: [InviteCodesService],
})
export class InviteCodesModule {}
