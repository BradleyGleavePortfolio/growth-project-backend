import { Injectable } from '@nestjs/common';
import {
  AVATAR_CROP_BY_SURFACE,
  COACH_COMMUNITY_SURFACE_KEYS,
  CoachCommunitySurfaceKey,
  LEGACY,
  ROMAN_V2,
  RomanCopyPayload,
  SurfaceKey,
} from './voice-policy.constants';
import { isRomanCopyV2Enabled } from './voice-policy.feature';

/**
 * VoicePolicyService — the single backend authority for Roman-voiced surface
 * copy + avatar crop. Given a `SurfaceKey` it returns a `RomanCopyPayload`
 * carrying BOTH the copy `text` AND the `avatar_crop` — never a bare string —
 * so no downstream channel can emit Roman's voice without his face
 * (operator-locked face+voice contract, 2026-06-10). The mobile client consumes
 * the payload verbatim, so the contract is never re-derived on the client.
 *
 * Variant selection (Phase 2 behaviour, preserved): `text` is the LEGACY
 * variant while `FEATURE_ROMAN_COPY_V2` is OFF (byte-for-byte what the surface
 * returned before P2, pinned by a snapshot contract test) and the Roman
 * Option-3 variant while it is ON. Flag resolution is delegated to
 * `isRomanCopyV2Enabled()`, the single authority (default OFF; ON only when the
 * env value is exactly `'true'`). The env is read per call so the operator can
 * flip the flag without a restart and so tests can set it per-case without DI
 * gymnastics.
 *
 * The v1-6 coach-community empty-state surfaces are greenfield (LEGACY copy is
 * identical to ROMAN_V2), so the flag does not change their visible copy — it
 * only stamps the analytics `voice_variant`. `allCopy(subset)` composes a set
 * of surfaces in one pass for the coach empty-states controller, defaulting to
 * the coach subset so the coach response carries ONLY the five coach surfaces.
 *
 * No silent failures: an unknown surface key is a programming error and throws
 * loudly rather than returning empty copy (which would ship a blank
 * notification). Every key in the union is present in both maps, so a lookup
 * miss can only mean a caller passed a value outside the type.
 */
@Injectable()
export class VoicePolicyService {
  /**
   * Resolve the copy payload for a single surface.
   *
   * @param surfaceKey one of the Roman-voiced surface keys (P2 or coach v1-6)
   * @param env        process env (injectable for tests); defaults to process.env
   * @returns a `RomanCopyPayload` with non-empty `text`, a valid `avatar_crop`,
   *          the `surface_key`, and the resolved `voice_variant`.
   * @throws Error when `surfaceKey` is not a known surface (no silent failure)
   */
  copyFor(
    surfaceKey: SurfaceKey,
    env: NodeJS.ProcessEnv = process.env,
  ): RomanCopyPayload {
    const useRomanV2 = isRomanCopyV2Enabled(env);
    const source = useRomanV2 ? ROMAN_V2 : LEGACY;
    const text = source[surfaceKey];
    const avatar_crop = AVATAR_CROP_BY_SURFACE[surfaceKey];

    if (text === undefined || avatar_crop === undefined) {
      // No silent failure: a missing surface ships a blank notification, which
      // is worse than a loud error the operator catches in CI / logs.
      throw new Error(
        `VoicePolicyService.copyFor: unknown surface key "${String(
          surfaceKey,
        )}" — no copy registered`,
      );
    }

    return {
      text,
      avatar_crop,
      surface_key: surfaceKey,
      voice_variant: useRomanV2 ? 'roman_v2' : 'legacy',
    };
  }

  /**
   * Compose a payload for each surface in `surfaceKeys`, keyed by surface_key,
   * so a controller can return a whole surface set in one round-trip. Defaults
   * to the v1-6 coach-community subset (the coach empty-states controller's
   * use), so the coach response is never forced to carry the P2 notification
   * surfaces. Flag-aware per `copyFor()`.
   */
  allCopy(): Record<CoachCommunitySurfaceKey, RomanCopyPayload>;
  allCopy<K extends SurfaceKey>(
    surfaceKeys: readonly K[],
    env?: NodeJS.ProcessEnv,
  ): Record<K, RomanCopyPayload>;
  allCopy(
    surfaceKeys: readonly SurfaceKey[] = COACH_COMMUNITY_SURFACE_KEYS,
    env: NodeJS.ProcessEnv = process.env,
  ): Record<SurfaceKey, RomanCopyPayload> {
    const out = {} as Record<SurfaceKey, RomanCopyPayload>;
    for (const key of surfaceKeys) {
      out[key] = this.copyFor(key, env);
    }
    return out;
  }
}
