/**
 * CommunityCoachEmptyStatesController — GET /community/coach/empty-states.
 *
 * Returns the operator-locked Roman copy payload for every v1-6
 * coach-community empty-state surface in one round-trip, keyed by surface_key.
 * The mobile client (useCoachEmptyStates) caches this for the session so each
 * empty state renders backend-sourced { text, avatar_crop, surface_key,
 * voice_variant } instead of hardcoded constants (the operator face+voice
 * contract locked 2026-06-10).
 *
 * Guard order mirrors the other v1-6 coach controllers: JwtAuthGuard →
 * RolesGuard → CommunityFeatureFlagGuard (503 when the master flag is off).
 * @Roles('coach','owner') is the coarse gate; the copy itself is tenant
 * agnostic (it is policy, not data), so no per-tenant scoping is required
 * beyond the coach-role gate.
 *
 * The composed payload is Zod-validated against CoachEmptyStatesResponseSchema
 * before it leaves the handler so a policy/contract drift fails here rather
 * than on the client.
 *
 * VARIANT NOTE (Roman P2 ⋃ v1-6 union): `FEATURE_ROMAN_COPY_V2` gates the P2
 * dunning/billing notification rollout — NOT the coach-community empty states,
 * whose Roman copy is operator-locked and always served (the face+voice
 * contract). The coach surfaces are greenfield (LEGACY copy === ROMAN_V2 copy),
 * so the flag could only change the analytics `voice_variant` stamp; the
 * controller therefore composes the coach subset with the Roman variant pinned
 * ON, independent of the dunning rollout flag, so a coach empty state is never
 * stamped `legacy` just because the unrelated dunning flag is off.
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CommunityFeatureFlagGuard } from '../community-feature-flag.guard';
import { VoicePolicyService } from '../../roman/voice/voice-policy.service';
import { COACH_COMMUNITY_SURFACE_KEYS } from '../../roman/voice/voice-policy.constants';
import { FEATURE_ROMAN_COPY_V2_ENV } from '../../roman/voice/voice-policy.feature';
import {
  CoachEmptyStatesResponseSchema,
  type CoachEmptyStatesResponse,
} from './dto/coach-empty-states.dto';

@ApiTags('community')
@Controller('community')
export class CommunityCoachEmptyStatesController {
  constructor(private readonly voicePolicy: VoicePolicyService) {}

  @Get('coach/empty-states')
  @UseGuards(JwtAuthGuard, RolesGuard, CommunityFeatureFlagGuard)
  @Roles('coach', 'owner')
  emptyStates(): CoachEmptyStatesResponse {
    // Pin the Roman variant ON for the coach subset, independent of the P2
    // dunning rollout flag — the coach copy is operator-locked, not part of
    // that rollout.
    const composed = this.voicePolicy.allCopy(COACH_COMMUNITY_SURFACE_KEYS, {
      [FEATURE_ROMAN_COPY_V2_ENV]: 'true',
    });
    // Validate the composed payload at the egress boundary — a drift between
    // the VoicePolicy maps and the wire contract fails here, not on the client.
    return CoachEmptyStatesResponseSchema.parse(composed);
  }
}
