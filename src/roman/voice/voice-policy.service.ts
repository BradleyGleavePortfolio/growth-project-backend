import { Injectable } from '@nestjs/common';
import {
  AVATAR_CROP_BY_SURFACE,
  LEGACY,
  ROMAN_V2,
  RomanCopyPayload,
  SurfaceKey,
} from './voice-policy.constants';
import { isRomanCopyV2Enabled } from './voice-policy.feature';

/**
 * Roman Phase 2 — VoicePolicyService.
 *
 * The single adapter every Phase 2 in-app notification surface funnels through.
 * Given a `SurfaceKey` it returns a `RomanCopyPayload` carrying BOTH the copy
 * `text` AND the `avatar_crop` — never a bare string. The text is the LEGACY
 * variant while `FEATURE_ROMAN_COPY_V2` is OFF (byte-for-byte what the surface
 * returned before this PR) and the Roman Option-3 variant while it is ON. The
 * `avatar_crop` is the locked crop for that surface, emitted in both variants
 * so a downstream channel can never carry Roman's voice without his face.
 *
 * Flag resolution is delegated to `isRomanCopyV2Enabled()`, the single
 * authority (default OFF; ON only when the env value is exactly `'true'`). The
 * env is read per call so the operator can flip the flag without a restart and
 * so tests can set it per-case without DI gymnastics.
 *
 * No silent failures: an unknown surface key is a programming error and throws
 * loudly rather than returning empty copy (which would ship a blank
 * notification to a user). Every key in the union is present in both maps, so a
 * lookup miss can only mean a caller passed a value outside the type.
 */
@Injectable()
export class VoicePolicyService {
  /**
   * Resolve the copy payload for a surface.
   *
   * @param surfaceKey one of the ten Phase 2 surface keys
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
}
