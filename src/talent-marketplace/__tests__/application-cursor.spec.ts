import {
  buildTupleCursor,
  parseTupleCursor,
  type TupleCursor,
} from '../application-cursor';

// application-cursor encodes the (created_at, id) keyset boundary as an opaque
// base64url blob. Tests pin roundtrip fidelity and graceful (null, not throw)
// degradation on any tampered/garbage input.

const ROW: TupleCursor = {
  created_at: new Date('2026-06-18T04:41:00.000Z'),
  id: '11111111-2222-3333-4444-555555555555',
};

describe('buildTupleCursor / parseTupleCursor — roundtrip', () => {
  it('roundtrips a (created_at, id) tuple exactly', () => {
    const parsed = parseTupleCursor(buildTupleCursor(ROW));
    expect(parsed).not.toBeNull();
    expect(parsed?.created_at.toISOString()).toBe(ROW.created_at.toISOString());
    expect(parsed?.id).toBe(ROW.id);
  });

  it('produces an opaque base64url token (no raw timestamp/id visible)', () => {
    const cursor = buildTupleCursor(ROW);
    expect(cursor).not.toContain('|');
    expect(cursor).not.toContain(ROW.id);
    expect(cursor).not.toContain('2026-06-18');
    // base64url alphabet only
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('preserves ids that themselves contain a pipe-like payload boundary', () => {
    const weird: TupleCursor = { created_at: ROW.created_at, id: 'a|b|c' };
    const parsed = parseTupleCursor(buildTupleCursor(weird));
    // split is on the FIRST separator, so the id remainder survives intact
    expect(parsed?.id).toBe('a|b|c');
  });
});

describe('parseTupleCursor — tamper / malformed degrade to null', () => {
  it('returns null for non-base64 garbage', () => {
    expect(parseTupleCursor('!!!not base64!!!')).toBeNull();
  });

  it('returns null for a valid-base64 blob with no separator', () => {
    const noSep = Buffer.from('no-separator-here', 'utf8').toString('base64url');
    expect(parseTupleCursor(noSep)).toBeNull();
  });

  it('returns null when the timestamp half is not a date', () => {
    const badDate = Buffer.from('not-a-date|some-id', 'utf8').toString('base64url');
    expect(parseTupleCursor(badDate)).toBeNull();
  });

  it('returns null when the id half is empty', () => {
    const emptyId = Buffer.from(`${ROW.created_at.toISOString()}|`, 'utf8').toString('base64url');
    expect(parseTupleCursor(emptyId)).toBeNull();
  });

  it('returns null when the separator is at position 0 (empty timestamp)', () => {
    const emptyTs = Buffer.from('|some-id', 'utf8').toString('base64url');
    expect(parseTupleCursor(emptyTs)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseTupleCursor('')).toBeNull();
  });

  // A-P1-2: Date.parse coerces partial/garbage timestamps ('2026', '2026-01',
  // '99') to valid dates. The strict round-trip rejects anything that is not
  // the exact ISO string the encoder emits, so a hand-crafted cursor degrades
  // to page 1 instead of silently shifting the keyset window.
  it('returns null for non-round-trippable timestamp halves (tamper)', () => {
    for (const ts of ['2026', '2026-01', '99', '2026-06-18']) {
      const tampered = Buffer.from(`${ts}|some-id`, 'utf8').toString('base64url');
      expect(parseTupleCursor(tampered)).toBeNull();
    }
  });

  it('still accepts a full canonical ISO timestamp', () => {
    const iso = '2026-06-18T04:41:00.000Z';
    const good = Buffer.from(`${iso}|some-id`, 'utf8').toString('base64url');
    const parsed = parseTupleCursor(good);
    expect(parsed?.created_at.toISOString()).toBe(iso);
    expect(parsed?.id).toBe('some-id');
  });
});
