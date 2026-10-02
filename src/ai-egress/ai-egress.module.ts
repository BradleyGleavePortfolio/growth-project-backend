/**
 * AiEgressModule — R2b. Global so every module with an AI call site can
 * inject AiEgressService without new import edges (the same pattern as the
 * global Prisma and audit modules). It imports AiConsentModule for the
 * narrow CLIENT_AI_CONSENT_READER token only.
 */
import { Global, Module } from '@nestjs/common';
import { AiConsentModule } from '../ai-consent/ai-consent.module';
import { AiEgressService } from './ai-egress.service';

@Global()
@Module({
  imports: [AiConsentModule],
  providers: [AiEgressService],
  exports: [AiEgressService],
})
export class AiEgressModule {}
