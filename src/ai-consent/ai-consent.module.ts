/**
 * AiConsentModule — the AI processing consent ledger (R2a, D2 box 2).
 *
 * Exports AiConsentService and the narrow CLIENT_AI_CONSENT_READER token. AI
 * paths (R2b) should depend on the token, not on the service, so the only
 * capability they get is the read.
 *
 * JwtAuthGuard / RolesGuard come from the @Global SecurityGuardsModule and
 * PrismaService is global, so this module imports nothing (no new graph edges).
 */
import { Module } from '@nestjs/common';
import { AiConsentController, AiConsentLedgerGuard } from './ai-consent.controller';
import { CLIENT_AI_CONSENT_READER } from './ai-consent.reader';
import { AiConsentService } from './ai-consent.service';

@Module({
  controllers: [AiConsentController],
  providers: [
    AiConsentService,
    AiConsentLedgerGuard,
    { provide: CLIENT_AI_CONSENT_READER, useExisting: AiConsentService },
  ],
  exports: [AiConsentService, CLIENT_AI_CONSENT_READER],
})
export class AiConsentModule {}
