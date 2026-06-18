import {
  ADMIN_REVIEW_DEFAULT_LIMIT,
  ADMIN_REVIEW_MAX_LIMIT,
  ADMIN_REVIEW_MIN_LIMIT,
  buildReviewCursor,
  clampReviewLimit,
  parseReviewCursor,
} from '../admin-review-cursor';

// TM-7 — the keyset tuple cursor backs both admin review queues. Invariants:
//   1. round-trip — a built cursor decodes back to the exact (created_at, id).
//   2. tamper-tolerant — malformed/garbage input degrades to null ("page 1")
//      rather than throwing.
//   3. limit clamp — bounded to [MIN, MAX], defaults when omitted, and the
//      NaN guard (P3-5) returns the default rather than poisoning `take`.

describe('admin-review-cursor — round-trip', () => {
  it('encodes and decodes the (created_at, id) tuple losslessly', () => {
    const created_at = new Date('2026-06-18T04:41:00.000Z');
    const id = '11111111-2222-3333-4444-555555555555';
    const token = buildReviewCursor({ created_at, id });
    const parsed = parseReviewCursor(token);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(id);
    expect(parsed?.created_at.toISOString()).toBe(created_at.toISOString());
  });

  it('produces an opaque base64url blob (no raw delimiter visible)', () => {
    const token = buildReviewCursor({
      created_at: new Date('2026-06-18T04:41:00.000Z'),
      id: 'abc',
    });
    expect(token).not.toContain('|');
    expect(token).not.toContain(' ');
  });
});

describe('admin-review-cursor — tamper tolerance', () => {
  it.each([
    ['empty string', ''],
    ['no delimiter', Buffer.from('nopipe', 'utf8').toString('base64url')],
    ['leading delimiter', Buffer.from('|only-id', 'utf8').toString('base64url')],
    ['trailing delimiter', Buffer.from('iso|', 'utf8').toString('base64url')],
    ['unparseable date', Buffer.from('not-a-date|id', 'utf8').toString('base64url')],
    ['raw garbage', '!!!not-base64!!!'],
  ])('returns null for %s', (_label, input) => {
    expect(parseReviewCursor(input)).toBeNull();
  });
});

describe('admin-review-cursor — clampReviewLimit', () => {
  it('defaults when omitted', () => {
    expect(clampReviewLimit(undefined)).toBe(ADMIN_REVIEW_DEFAULT_LIMIT);
  });

  it('returns the default for NaN (P3-5 guard)', () => {
    expect(clampReviewLimit(Number.NaN)).toBe(ADMIN_REVIEW_DEFAULT_LIMIT);
  });

  it('clamps below MIN up to MIN', () => {
    expect(clampReviewLimit(0)).toBe(ADMIN_REVIEW_MIN_LIMIT);
    expect(clampReviewLimit(-5)).toBe(ADMIN_REVIEW_MIN_LIMIT);
  });

  it('clamps above MAX down to MAX', () => {
    expect(clampReviewLimit(9_999)).toBe(ADMIN_REVIEW_MAX_LIMIT);
  });

  it('truncates a fractional limit', () => {
    expect(clampReviewLimit(12.9)).toBe(12);
  });
});
