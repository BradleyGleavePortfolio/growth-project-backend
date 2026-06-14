/**
 * ED.6 — FEATURE_ROMAN_COACH_REVIEWED_AT flag resolution.
 *
 * Pins the default-OFF invariant: the side-effect writes that stamp a coach
 * review are enabled ONLY when the env value is exactly 'true' (case-insensitive).
 * Unset / empty / any other value resolves OFF, identical in every environment.
 */
import {
  isCoachReviewedAtEnabled,
  FEATURE_ROMAN_COACH_REVIEWED_AT_ENV,
} from '../src/roman/coach-reviewed.feature';

describe('isCoachReviewedAtEnabled', () => {
  const KEY = FEATURE_ROMAN_COACH_REVIEWED_AT_ENV;

  it('exports the canonical env var name', () => {
    expect(KEY).toBe('FEATURE_ROMAN_COACH_REVIEWED_AT');
  });

  it('is OFF when the var is unset (default-OFF invariant)', () => {
    expect(isCoachReviewedAtEnabled({})).toBe(false);
  });

  it.each(['true', 'TRUE', 'True', 'tRuE'])(
    'is ON when the var is exactly %p (case-insensitive)',
    (v) => {
      expect(isCoachReviewedAtEnabled({ [KEY]: v })).toBe(true);
    },
  );

  it.each(['false', '1', 'yes', 'on', '', ' true ', 'truthy'])(
    'is OFF for any non-"true" value (%p)',
    (v) => {
      expect(isCoachReviewedAtEnabled({ [KEY]: v })).toBe(false);
    },
  );

  it('reads process.env by default', () => {
    const prev = process.env[KEY];
    try {
      delete process.env[KEY];
      expect(isCoachReviewedAtEnabled()).toBe(false);
      process.env[KEY] = 'true';
      expect(isCoachReviewedAtEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    }
  });
});
