import { Module } from '@nestjs/common';
import { JwksVerifierService } from '../auth/jwks.service';
import { BillingModule } from '../billing/billing.module';
import { AuditModule } from '../audit/audit.module';
import { CoachOrOwnerGuard } from '../common/guards/coach-or-owner.guard';
import { V1CoachController } from './v1-coach.controller';
import { V1CoachService } from './v1-coach.service';

// V1 BFF module. Imports BillingModule so the SubscriptionGuard can be
// resolved on the message/draft write routes. AuditModule provides AuditService
// for OWNER-initiated send/read events.
@Module({
  imports: [BillingModule, AuditModule],
  controllers: [V1CoachController],
  providers: [V1CoachService, CoachOrOwnerGuard, JwksVerifierService],
  exports: [V1CoachService],
})
export class V1Module {}
