/**
 * Unit tests for the v3-2 release-lock logic (community-classroom-release.feature).
 *
 * These are pure, DB-free functions that are the single source of truth for
 * "is this lesson visible to a student right now?" and "what status should a
 * publish produce?". The RLS member-select policy and the repository feed filter
 * mirror the SAME predicate, so pinning the function behaviour here pins all
 * three (Failure #15 duplicated business rule).
 *
 * Guarantees proven:
 *   - A future release_at publishes as `scheduled`; a null/past one as `published`.
 *   - A published-but-future lesson is release-locked (badge shown, media hidden).
 *   - Student visibility requires published + released + not-soft-deleted — every
 *     other combination is invisible.
 */
import {
  isReleaseLocked,
  isStudentVisible,
  statusForPublish,
} from '../../../src/community/classroom/community-classroom-release.feature';

const NOW = new Date('2026-03-01T00:00:00.000Z');
const PAST = new Date('2026-02-01T00:00:00.000Z');
const FUTURE = new Date('2026-04-01T00:00:00.000Z');

describe('statusForPublish', () => {
  it('publishes immediately when release_at is null', () => {
    expect(statusForPublish(null, NOW)).toBe('published');
  });

  it('publishes immediately when release_at is in the past', () => {
    expect(statusForPublish(PAST, NOW)).toBe('published');
  });

  it('schedules when release_at is in the future', () => {
    expect(statusForPublish(FUTURE, NOW)).toBe('scheduled');
  });

  it('treats release_at exactly equal to now as released (published)', () => {
    expect(statusForPublish(new Date(NOW), NOW)).toBe('published');
  });
});

describe('isReleaseLocked', () => {
  it('is true for a published lesson whose release_at is in the future', () => {
    expect(isReleaseLocked('published', FUTURE, NOW)).toBe(true);
  });

  it('is true for a scheduled lesson whose release_at is in the future', () => {
    expect(isReleaseLocked('scheduled', FUTURE, NOW)).toBe(true);
  });

  it('is false for a published lesson whose release_at has passed', () => {
    expect(isReleaseLocked('published', PAST, NOW)).toBe(false);
  });

  it('is false for a published lesson with no release_at', () => {
    expect(isReleaseLocked('published', null, NOW)).toBe(false);
  });

  it('is false for a draft lesson (not published → not "locked", just hidden)', () => {
    expect(isReleaseLocked('draft', FUTURE, NOW)).toBe(false);
  });

  it('is false for an archived lesson', () => {
    expect(isReleaseLocked('archived', FUTURE, NOW)).toBe(false);
  });
});

describe('isStudentVisible', () => {
  it('is visible when published, released, and not soft-deleted', () => {
    expect(
      isStudentVisible(
        { status: 'published', releaseAt: PAST, softDeletedAt: null },
        NOW,
      ),
    ).toBe(true);
  });

  it('is visible when published with no release_at', () => {
    expect(
      isStudentVisible(
        { status: 'published', releaseAt: null, softDeletedAt: null },
        NOW,
      ),
    ).toBe(true);
  });

  it('is hidden when published but release_at is in the future (release lock)', () => {
    expect(
      isStudentVisible(
        { status: 'published', releaseAt: FUTURE, softDeletedAt: null },
        NOW,
      ),
    ).toBe(false);
  });

  it('is hidden when scheduled (never visible regardless of release time)', () => {
    expect(
      isStudentVisible(
        { status: 'scheduled', releaseAt: PAST, softDeletedAt: null },
        NOW,
      ),
    ).toBe(false);
  });

  it('is hidden when draft', () => {
    expect(
      isStudentVisible(
        { status: 'draft', releaseAt: null, softDeletedAt: null },
        NOW,
      ),
    ).toBe(false);
  });

  it('is hidden when soft-deleted even if otherwise published + released', () => {
    expect(
      isStudentVisible(
        { status: 'published', releaseAt: PAST, softDeletedAt: NOW },
        NOW,
      ),
    ).toBe(false);
  });

  it('becomes visible exactly at release_at === now', () => {
    expect(
      isStudentVisible(
        { status: 'published', releaseAt: new Date(NOW), softDeletedAt: null },
        NOW,
      ),
    ).toBe(true);
  });
});
