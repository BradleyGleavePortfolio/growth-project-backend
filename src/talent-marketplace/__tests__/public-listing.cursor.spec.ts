import {
  buildTupleCursor,
  parseTupleCursor,
} from '../public-listing.cursor';

// TM-3 keyset tuple cursor — round-trip + edge coverage. The cursor must be a
// stable, opaque (created_at, id) tuple: a built cursor parses back to the same
// instant + id, and any malformed/hand-crafted input degrades to null ("page
// 1") rather than throwing.

describe('buildTupleCursor / parseTupleCursor round-trip', () => {
  it('round-trips a (created_at, id) tuple preserving millisecond precision', () => {
    const created_at = new Date('2026-06-18T09:41:07.123Z');
    const id = 'a3f1c2e4-0000-4000-8000-000000000001';
    const parsed = parseTupleCursor(buildTupleCursor({ created_at, id }));
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(id);
    expect(parsed?.created_at.toISOString()).toBe(created_at.toISOString());
    expect(parsed?.created_at.getTime()).toBe(created_at.getTime());
  });

  it('emits an opaque base64url blob (no tuple internals leaked verbatim)', () => {
    const created_at = new Date('2026-01-02T03:04:05.000Z');
    const id = 'listing-xyz';
    const cursor = buildTupleCursor({ created_at, id });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain('|');
    expect(cursor).not.toContain(id);
  });

  it('produces distinct cursors for rows sharing a created_at but differing by id', () => {
    const created_at = new Date('2026-03-03T12:00:00.000Z');
    const a = buildTupleCursor({ created_at, id: 'id-a' });
    const b = buildTupleCursor({ created_at, id: 'id-b' });
    expect(a).not.toBe(b);
    expect(parseTupleCursor(a)?.id).toBe('id-a');
    expect(parseTupleCursor(b)?.id).toBe('id-b');
  });
});

describe('parseTupleCursor edge cases', () => {
  it('returns null for an empty string (first page / no cursor)', () => {
    expect(parseTupleCursor('')).toBeNull();
  });

  it('returns null for a blob missing the separator', () => {
    const noSep = Buffer.from('2026-06-18T00:00:00.000Z', 'utf8').toString(
      'base64url',
    );
    expect(parseTupleCursor(noSep)).toBeNull();
  });

  it('returns null when the id half is empty', () => {
    const emptyId = Buffer.from('2026-06-18T00:00:00.000Z|', 'utf8').toString(
      'base64url',
    );
    expect(parseTupleCursor(emptyId)).toBeNull();
  });

  it('returns null when the date half is unparseable', () => {
    const badDate = Buffer.from('not-a-date|some-id', 'utf8').toString(
      'base64url',
    );
    expect(parseTupleCursor(badDate)).toBeNull();
  });

  it('returns null when the separator is the leading character (empty date)', () => {
    const leadingSep = Buffer.from('|some-id', 'utf8').toString('base64url');
    expect(parseTupleCursor(leadingSep)).toBeNull();
  });

  it('round-trips an id that itself contains a "|" (separator is the FIRST pipe only)', () => {
    const created_at = new Date('2026-06-18T09:41:07.123Z');
    const id = 'weird|id|with|pipes';
    const parsed = parseTupleCursor(buildTupleCursor({ created_at, id }));
    expect(parsed?.id).toBe(id);
    expect(parsed?.created_at.toISOString()).toBe(created_at.toISOString());
  });

  it('decodes a final-page cursor (the last row still yields a valid tuple)', () => {
    // The service emits next_cursor=null on the last page, but a previously
    // issued cursor pointing AT the last row must still decode cleanly.
    const created_at = new Date('2020-12-31T23:59:59.999Z');
    const parsed = parseTupleCursor(
      buildTupleCursor({ created_at, id: 'last-row' }),
    );
    expect(parsed?.id).toBe('last-row');
    expect(parsed?.created_at.getTime()).toBe(created_at.getTime());
  });
});
