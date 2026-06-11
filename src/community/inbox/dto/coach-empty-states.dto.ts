/**
 * coach-empty-states.dto — Zod response schema for
 * GET /community/coach/empty-states.
 *
 * Mirrors the mobile client's RomanCopyPayloadSchema / CoachEmptyStatesResponse
 * (src/api/coachCommunityApi.ts). The backend is the source of truth; this
 * schema validates the composed payload before it leaves the controller so a
 * drift between the VoicePolicy maps and the wire contract fails the backend
 * test/CI rather than the mobile client at runtime.
 *
 * UNION NOTE: the Roman voice policy now spans BOTH the Phase 2 notification
 * surfaces and the v1-6 coach-community surfaces. This coach DTO intentionally
 * scopes itself to `COACH_COMMUNITY_SURFACE_KEYS` (the five coach surfaces),
 * NOT the full `SURFACE_KEYS` union — the coach empty-states response must
 * require exactly the five coach surfaces and reject the ten P2 notification
 * surfaces, which are delivered through a different channel. The
 * `surface_key` enum is likewise scoped to the coach subset so a P2 key in a
 * coach payload fails validation.
 */
import { z } from 'zod';
import {
  AVATAR_CROPS,
  COACH_COMMUNITY_SURFACE_KEYS,
  VOICE_VARIANTS,
} from '../../../roman/voice/voice-policy.constants';

export const CoachAvatarCropSchema = z.enum(AVATAR_CROPS);
export const CoachVoiceVariantSchema = z.enum(VOICE_VARIANTS);
export const CoachEmptyStateSurfaceKeySchema = z.enum(
  COACH_COMMUNITY_SURFACE_KEYS,
);

export const RomanCopyPayloadSchema = z
  .object({
    text: z.string().min(1),
    avatar_crop: CoachAvatarCropSchema,
    surface_key: CoachEmptyStateSurfaceKeySchema,
    voice_variant: CoachVoiceVariantSchema,
  })
  .strict();

/**
 * Record keyed by every COACH surface_key. Built explicitly (rather than
 * z.record) so the schema fails if a coach surface is missing — the controller
 * MUST return all five coach surfaces.
 */
export const CoachEmptyStatesResponseSchema = z
  .object(
    COACH_COMMUNITY_SURFACE_KEYS.reduce(
      (shape, key) => {
        shape[key] = RomanCopyPayloadSchema;
        return shape;
      },
      {} as Record<
        (typeof COACH_COMMUNITY_SURFACE_KEYS)[number],
        typeof RomanCopyPayloadSchema
      >,
    ),
  )
  .strict();

export type CoachEmptyStatesResponse = z.infer<
  typeof CoachEmptyStatesResponseSchema
>;
