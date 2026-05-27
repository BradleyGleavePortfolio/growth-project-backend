/**
 * Nudge v1 — QuietHoursPolicy unit tests.
 *
 * Spec §4 boundaries (local time, user timezone):
 *   - allowed: [8am, 9pm)
 *   - hour ≥ 21 → defer to next day 8am
 *   - hour < 8  → defer to today 8am
 *
 * America/Los_Angeles is PDT (UTC-7) in May 2026; we use that as the
 * primary fixture timezone so the offset math is obvious.
 */

import { QuietHoursPolicy } from '../src/notifications/nudges/quiet-hours.policy';

describe('QuietHoursPolicy', () => {
  it('allows mid-day local time (11am LA)', () => {
    const utc = new Date('2026-05-08T18:00:00Z'); // 11am PDT
    const out = QuietHoursPolicy.evaluate(utc, 'America/Los_Angeles');
    expect(out.allowed).toBe(true);
    expect(out.deferred_until).toBeUndefined();
  });

  it('allows the lower boundary 8am LA', () => {
    const utc = new Date('2026-05-08T15:00:00Z'); // 8am PDT
    const out = QuietHoursPolicy.evaluate(utc, 'America/Los_Angeles');
    expect(out.allowed).toBe(true);
  });

  it('blocks 9pm LA exactly and defers to next day 8am', () => {
    const utc = new Date('2026-05-09T04:00:00Z'); // 9pm prior-day PDT
    const out = QuietHoursPolicy.evaluate(utc, 'America/Los_Angeles');
    expect(out.allowed).toBe(false);
    // Next day's 8am PDT = 15:00 UTC.
    expect(out.deferred_until!.toISOString()).toBe('2026-05-09T15:00:00.000Z');
  });

  it('blocks 11pm LA and defers to next day 8am', () => {
    const utc = new Date('2026-05-09T06:00:00Z'); // 11pm prior-day PDT
    const out = QuietHoursPolicy.evaluate(utc, 'America/Los_Angeles');
    expect(out.allowed).toBe(false);
    expect(out.deferred_until!.toISOString()).toBe('2026-05-09T15:00:00.000Z');
  });

  it('blocks 3am LA and defers to same-day 8am', () => {
    const utc = new Date('2026-05-08T10:00:00Z'); // 3am PDT
    const out = QuietHoursPolicy.evaluate(utc, 'America/Los_Angeles');
    expect(out.allowed).toBe(false);
    expect(out.deferred_until!.toISOString()).toBe('2026-05-08T15:00:00.000Z');
  });

  it('falls back to default tz on invalid input', () => {
    const utc = new Date('2026-05-08T18:00:00Z'); // 11am PDT (default fallback)
    const out = QuietHoursPolicy.evaluate(utc, 'Not/A_RealZone');
    // Default fallback is America/Los_Angeles; 11am is allowed.
    expect(out.allowed).toBe(true);
  });

  it('respects a non-LA timezone (UTC)', () => {
    // 22:00 UTC in UTC tz is past 9pm → defer.
    const utc = new Date('2026-05-08T22:00:00Z');
    const out = QuietHoursPolicy.evaluate(utc, 'UTC');
    expect(out.allowed).toBe(false);
    expect(out.deferred_until!.toISOString()).toBe('2026-05-09T08:00:00.000Z');
  });

  it('respects Asia/Tokyo across the date line', () => {
    // 2026-05-08 23:00 UTC = 2026-05-09 08:00 JST. Tokyo is exactly at the
    // 8am open boundary → allowed.
    const utc = new Date('2026-05-08T23:00:00Z');
    const out = QuietHoursPolicy.evaluate(utc, 'Asia/Tokyo');
    expect(out.allowed).toBe(true);
  });
});
