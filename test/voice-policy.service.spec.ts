/**
 * VoicePolicyService unit coverage (v1-6 coach-community surfaces).
 *
 * After the Roman P2 ⋃ v1-6 union, the voice policy spans BOTH the ten P2
 * notification surfaces and the five coach-community empty-state surfaces. The
 * P2 surfaces are covered exhaustively by the suites under
 * `src/roman/voice/__tests__/`; this suite owns the COACH subset.
 *
 * It asserts the policy composes a well-formed RomanCopyPayload for every coach
 * surface, that the avatar crop matches the locked matrix (moderation = smile,
 * everything else = neutral), that the copy obeys the ROMAN_VOICE_POLICY §4
 * rules (no exclamation, no emoji, no "Oops/Whoops/Uh oh", never "— The TGP
 * Team"), that the coach surfaces are greenfield (LEGACY === ROMAN_V2 copy, so
 * the flag only flips the analytics `voice_variant`), and that
 * `allCopy()` returns exactly the five coach surfaces with no extras and no
 * P2 leakage.
 */
import 'reflect-metadata';
import { VoicePolicyService } from '../src/roman/voice/voice-policy.service';
import {
  COACH_COMMUNITY_SURFACE_KEYS,
  AVATAR_CROP_BY_SURFACE,
  ROMAN_V2,
  LEGACY,
} from '../src/roman/voice/voice-policy.constants';

const FLAG = 'FEATURE_ROMAN_COPY_V2';
const ON: NodeJS.ProcessEnv = { [FLAG]: 'true' };
const OFF: NodeJS.ProcessEnv = { [FLAG]: 'false' };

describe('VoicePolicyService — coach-community surfaces', () => {
  const svc = new VoicePolicyService();

  it('composes a flag-ON payload for every coach surface (exhaustive)', () => {
    for (const key of COACH_COMMUNITY_SURFACE_KEYS) {
      const payload = svc.copyFor(key, ON);
      expect(payload.surface_key).toBe(key);
      expect(payload.text.length).toBeGreaterThan(0);
      expect(payload.text).toBe(ROMAN_V2[key]);
      expect(payload.avatar_crop).toBe(AVATAR_CROP_BY_SURFACE[key]);
      expect(payload.voice_variant).toBe('roman_v2');
    }
  });

  it('coach surfaces are greenfield: LEGACY copy equals ROMAN_V2 copy', () => {
    for (const key of COACH_COMMUNITY_SURFACE_KEYS) {
      expect(LEGACY[key]).toBe(ROMAN_V2[key]);
      // Flag OFF still yields the same visible copy, only the variant differs.
      const off = svc.copyFor(key, OFF);
      expect(off.text).toBe(ROMAN_V2[key]);
      expect(off.voice_variant).toBe('legacy');
    }
  });

  it('uses the smile crop for the cleared moderation queue and neutral elsewhere', () => {
    expect(svc.copyFor('coach_community_moderation_empty', ON).avatar_crop).toBe(
      'smile',
    );
    expect(svc.copyFor('coach_community_home_empty', ON).avatar_crop).toBe(
      'neutral',
    );
    expect(svc.copyFor('coach_community_inbox_empty', ON).avatar_crop).toBe(
      'neutral',
    );
    expect(svc.copyFor('coach_community_cohorts_empty', ON).avatar_crop).toBe(
      'neutral',
    );
    expect(
      svc.copyFor('coach_community_cohort_members_empty', ON).avatar_crop,
    ).toBe('neutral');
  });

  it('obeys ROMAN_VOICE_POLICY §4 copy rules for every coach surface', () => {
    for (const key of COACH_COMMUNITY_SURFACE_KEYS) {
      const { text } = svc.copyFor(key, ON);
      expect(text).not.toMatch(/!/);
      expect(text).not.toMatch(/\b(oops|whoops|uh oh)\b/i);
      expect(text).not.toContain('— The TGP Team');
      // No emoji (basic surrogate-pair / pictograph guard).
      expect(text).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
  });

  it('allCopy() returns exactly the five coach surfaces, no extras and no P2 leakage', () => {
    const all = svc.allCopy(COACH_COMMUNITY_SURFACE_KEYS, ON);
    const returned = Object.keys(all).sort();
    expect(returned).toEqual([...COACH_COMMUNITY_SURFACE_KEYS].sort());
    for (const key of COACH_COMMUNITY_SURFACE_KEYS) {
      expect(all[key]).toEqual(svc.copyFor(key, ON));
    }
  });

  it('allCopy() defaults to the coach subset', () => {
    const all = svc.allCopy();
    expect(Object.keys(all).sort()).toEqual(
      [...COACH_COMMUNITY_SURFACE_KEYS].sort(),
    );
  });
});
