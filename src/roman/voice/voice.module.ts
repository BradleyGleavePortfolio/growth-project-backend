import { Module } from '@nestjs/common';
import { VoicePolicyService } from './voice-policy.service';

/**
 * VoiceModule — Phase 2 in-app copy policy (FEATURE_ROMAN_COPY_V2-gated).
 *
 * Provides and exports ONLY `VoicePolicyService` so the billing, notifications,
 * and onboarding surfaces can funnel their in-app copy through the single Roman
 * Option-3 source of truth without dragging in the Phase 1 chat controller,
 * guard, or Anthropic client. The service is stateless and reads its own
 * `FEATURE_ROMAN_COPY_V2` switch per call, so importing this module anywhere is
 * a no-op while the flag is OFF (legacy copy is returned verbatim).
 */
@Module({
  providers: [VoicePolicyService],
  exports: [VoicePolicyService],
})
export class VoiceModule {}
