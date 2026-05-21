import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { AuditModule } from '../audit/audit.module';
import { V1CoachController } from './v1-coach.controller';
import { V1CoachService } from './v1-coach.service';

// V1 BFF module. BillingModule import retained for SubscriptionGuard's
// historical resolution path — the guard itself is now provided by the
// @Global SecurityGuardsModule, but keeping the import edge avoids
// changing the dependency surface in this hotfix-prevention PR.
// AuditModule provides AuditService for OWNER-initiated send/read events.
//
// Local provider entries for CoachOrOwnerGuard and JwksVerifierService have
// been removed: both are exported by SecurityGuardsModule (@Global).
@Module({
  imports: [BillingModule, AuditModule],
  controllers: [V1CoachController],
  providers: [V1CoachService],
  exports: [V1CoachService],
})
export class V1Module {}
