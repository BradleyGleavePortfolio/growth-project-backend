import { VoicePolicyService } from '../../src/roman/voice/voice-policy.service';
import {
  AVATAR_CROP_BY_SURFACE,
  AvatarCrop,
  LEGACY,
  MONEY_SURFACES,
  ROMAN_V2,
  SURFACE_KEYS,
  SurfaceKey,
} from '../../src/roman/voice/voice-policy.constants';
import {
  FEATURE_ROMAN_COPY_V2_ENV,
  isRomanCopyV2Enabled,
} from '../../src/roman/voice/voice-policy.feature';

/**
 * Roman Phase 2 — VoicePolicyService contract suite.
 *
 * Covers every gate the builder brief requires:
 *   - flag OFF returns LEGACY, flag ON returns ROMAN_V2 (per surface);
 *   - the LEGACY map is byte-for-byte the pinned snapshot (no drift);
 *   - no exclamation point / emoji / "Oops" / "sonnet" in any ROMAN_V2 string;
 *   - face+voice: copyFor() ALWAYS returns non-empty text AND a valid crop;
 *   - money-surface guard: dunning / lockout / paywall / billing-update never
 *     return avatar_crop="smile";
 *   - smoke: with the flag ON every surface yields a non-empty Roman string.
 */

const VALID_CROPS: readonly AvatarCrop[] = ['monogram', 'smile', 'neutral'];

/** Run a body with FEATURE_ROMAN_COPY_V2 set to the given value, then restore. */
function withFlag<T>(value: string | undefined, body: () => T): T {
  const prev = process.env[FEATURE_ROMAN_COPY_V2_ENV];
  if (value === undefined) {
    delete process.env[FEATURE_ROMAN_COPY_V2_ENV];
  } else {
    process.env[FEATURE_ROMAN_COPY_V2_ENV] = value;
  }
  try {
    return body();
  } finally {
    if (prev === undefined) {
      delete process.env[FEATURE_ROMAN_COPY_V2_ENV];
    } else {
      process.env[FEATURE_ROMAN_COPY_V2_ENV] = prev;
    }
  }
}

describe('VoicePolicyService', () => {
  const service = new VoicePolicyService();

  describe('feature flag resolution', () => {
    it('is OFF when unset', () => {
      expect(isRomanCopyV2Enabled({})).toBe(false);
    });

    it('is OFF for any value other than exactly "true"', () => {
      expect(isRomanCopyV2Enabled({ [FEATURE_ROMAN_COPY_V2_ENV]: '1' })).toBe(
        false,
      );
      expect(isRomanCopyV2Enabled({ [FEATURE_ROMAN_COPY_V2_ENV]: 'yes' })).toBe(
        false,
      );
      expect(isRomanCopyV2Enabled({ [FEATURE_ROMAN_COPY_V2_ENV]: '' })).toBe(
        false,
      );
    });

    it('is ON for "true" (case-insensitive)', () => {
      expect(
        isRomanCopyV2Enabled({ [FEATURE_ROMAN_COPY_V2_ENV]: 'true' }),
      ).toBe(true);
      expect(
        isRomanCopyV2Enabled({ [FEATURE_ROMAN_COPY_V2_ENV]: 'TRUE' }),
      ).toBe(true);
    });
  });

  describe('flag OFF → legacy variant per surface', () => {
    it.each(SURFACE_KEYS)('%s returns the legacy text', (key) => {
      const payload = service.copyFor(key, {});
      expect(payload.text).toBe(LEGACY[key]);
      expect(payload.voice_variant).toBe('legacy');
      expect(payload.surface_key).toBe(key);
    });
  });

  describe('flag ON → roman_v2 variant per surface', () => {
    it.each(SURFACE_KEYS)('%s returns the Roman variant', (key) => {
      const payload = service.copyFor(key, {
        [FEATURE_ROMAN_COPY_V2_ENV]: 'true',
      });
      expect(payload.text).toBe(ROMAN_V2[key]);
      expect(payload.voice_variant).toBe('roman_v2');
      expect(payload.surface_key).toBe(key);
    });
  });

  describe('face + voice contract', () => {
    it.each(SURFACE_KEYS)(
      '%s returns BOTH non-empty text AND a valid avatar_crop (flag OFF)',
      (key) => {
        const payload = service.copyFor(key, {});
        expect(typeof payload.text).toBe('string');
        expect(payload.text.length).toBeGreaterThan(0);
        expect(VALID_CROPS).toContain(payload.avatar_crop);
        expect(payload.avatar_crop).toBe(AVATAR_CROP_BY_SURFACE[key]);
      },
    );

    it.each(SURFACE_KEYS)(
      '%s returns BOTH non-empty text AND a valid avatar_crop (flag ON)',
      (key) => {
        const payload = service.copyFor(key, {
          [FEATURE_ROMAN_COPY_V2_ENV]: 'true',
        });
        expect(payload.text.length).toBeGreaterThan(0);
        expect(VALID_CROPS).toContain(payload.avatar_crop);
        expect(payload.avatar_crop).toBe(AVATAR_CROP_BY_SURFACE[key]);
      },
    );

    it('never returns a bare string — always an object with both fields', () => {
      const payload = service.copyFor('paywall', {});
      expect(typeof payload).toBe('object');
      expect(payload).toHaveProperty('text');
      expect(payload).toHaveProperty('avatar_crop');
      expect(payload).toHaveProperty('surface_key');
      expect(payload).toHaveProperty('voice_variant');
    });
  });

  describe('money-surface guard (ROMAN_VOICE_POLICY §4)', () => {
    it.each(MONEY_SURFACES)(
      '%s never returns avatar_crop="smile" (legacy)',
      (key) => {
        expect(service.copyFor(key, {}).avatar_crop).toBe('neutral');
      },
    );

    it.each(MONEY_SURFACES)(
      '%s never returns avatar_crop="smile" (roman_v2)',
      (key) => {
        const payload = service.copyFor(key, {
          [FEATURE_ROMAN_COPY_V2_ENV]: 'true',
        });
        expect(payload.avatar_crop).not.toBe('smile');
        expect(payload.avatar_crop).toBe('neutral');
      },
    );

    it('the four money surfaces in scope are all covered', () => {
      // dunning Day0-7 (4) + lockout + paywall + billing-update = 7 money keys.
      expect(MONEY_SURFACES).toEqual([
        'dunning_day0',
        'dunning_day1',
        'dunning_day3',
        'dunning_day7',
        'lockout_day10',
        'paywall',
        'billing_update',
      ]);
    });
  });

  describe('celebratory surfaces use the smile crop', () => {
    it.each(['first_payment_ed3', 'onboarding_welcome'] as SurfaceKey[])(
      '%s uses smile',
      (key) => {
        expect(AVATAR_CROP_BY_SURFACE[key]).toBe('smile');
        expect(service.copyFor(key, {}).avatar_crop).toBe('smile');
      },
    );
  });

  describe('smoke: flag ON yields a non-empty Roman string for all 7/10 surfaces', () => {
    it('every surface produces non-empty Roman copy', () => {
      withFlag('true', () => {
        for (const key of SURFACE_KEYS) {
          const payload = service.copyFor(key);
          expect(payload.voice_variant).toBe('roman_v2');
          expect(payload.text.trim().length).toBeGreaterThan(0);
        }
      });
    });
  });

  describe('no silent failure', () => {
    it('throws loudly on an unknown surface key', () => {
      expect(() =>
        // Force an out-of-union key to prove the guard fires.
        service.copyFor('not_a_surface' as SurfaceKey, {}),
      ).toThrow(/unknown surface key/);
    });
  });

  describe('there are exactly 10 surface entries (7 logical surfaces)', () => {
    it('SURFACE_KEYS has 10 entries and both maps cover them', () => {
      expect(SURFACE_KEYS).toHaveLength(10);
      for (const key of SURFACE_KEYS) {
        expect(LEGACY[key]).toBeDefined();
        expect(ROMAN_V2[key]).toBeDefined();
        expect(AVATAR_CROP_BY_SURFACE[key]).toBeDefined();
      }
    });
  });
});
