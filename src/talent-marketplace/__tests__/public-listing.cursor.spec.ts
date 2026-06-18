import {
  buildTupleCursor,
  cursorSecretBootWarning,
  parseTupleCursor,
} from '../public-listing.cursor';

// TM-3 keyset tuple cursor — round-trip + edge + tamper coverage. The cursor
// must be a stable, opaque, HMAC-signed (created_at, id) tuple: a built cursor
// parses back to the same instant + id, and any malformed/hand-crafted/forged
// input degrades to null ("page 1") rather than throwing. Tamper-rejection is a
// non-security integrity check — a forged tuple could only reposition the keyset
// window over the SAME public, published rows — but signing keeps the token
// verifiable and the surface tidy (see threat model in public-listing.cursor.ts).

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

describe('parseTupleCursor — HMAC tamper rejection', () => {
  // A syntactically-valid, hand-crafted (created_at, id) tuple with NO signature
  // (the pre-HMAC wire format) must now be REJECTED. Pre-signing this exact blob
  // was ACCEPTED and shifted the keyset window; post-signing it degrades to
  // page 1. This is the explicit "forged cursor is rejected" case both lenses
  // asked for.
  it('rejects a hand-crafted unsigned tuple (Date.parse-able prefix + arbitrary id)', () => {
    const forged = Buffer.from(
      '2026-01-01T00:00:00.000Z|attacker-supplied-id',
      'utf8',
    ).toString('base64url');
    expect(parseTupleCursor(forged)).toBeNull();
  });

  it('rejects a tuple carrying a WRONG (forged) signature segment', () => {
    const forged = Buffer.from(
      '2026-01-01T00:00:00.000Z|some-id|deadbeefdeadbeef',
      'utf8',
    ).toString('base64url');
    expect(parseTupleCursor(forged)).toBeNull();
  });

  it('rejects a cursor whose payload was mutated after signing (signature no longer matches)', () => {
    const created_at = new Date('2026-06-18T09:41:07.123Z');
    const valid = buildTupleCursor({ created_at, id: 'real-id' });
    // Decode, swap the id while keeping the original signature, re-encode.
    const decoded = Buffer.from(valid, 'base64url').toString('utf8');
    const firstSep = decoded.indexOf('|');
    const lastSep = decoded.lastIndexOf('|');
    const iso = decoded.slice(0, firstSep);
    const sig = decoded.slice(lastSep + 1);
    const tampered = Buffer.from(`${iso}|swapped-id|${sig}`, 'utf8').toString(
      'base64url',
    );
    expect(parseTupleCursor(tampered)).toBeNull();
  });

  it('rejects a signed cursor when the verifying secret differs (cross-env safety)', () => {
    const created_at = new Date('2026-06-18T09:41:07.123Z');
    process.env.PUBLIC_LISTING_CURSOR_SECRET = 'secret-A';
    const signedWithA = buildTupleCursor({ created_at, id: 'env-id' });
    process.env.PUBLIC_LISTING_CURSOR_SECRET = 'secret-B';
    try {
      expect(parseTupleCursor(signedWithA)).toBeNull();
    } finally {
      delete process.env.PUBLIC_LISTING_CURSOR_SECRET;
    }
  });

  it('round-trips correctly when the same secret is configured on both ends', () => {
    const created_at = new Date('2026-06-18T09:41:07.123Z');
    process.env.PUBLIC_LISTING_CURSOR_SECRET = 'matched-secret';
    try {
      const parsed = parseTupleCursor(
        buildTupleCursor({ created_at, id: 'env-id' }),
      );
      expect(parsed?.id).toBe('env-id');
      expect(parsed?.created_at.getTime()).toBe(created_at.getTime());
    } finally {
      delete process.env.PUBLIC_LISTING_CURSOR_SECRET;
    }
  });
});

describe('cursorSecretBootWarning — prod misconfig signal (B-CYCLE-P3-1)', () => {
  // The env is injected so the matrix is deterministic and side-effect-free
  // (no mutation of the real process.env).
  it('warns when NODE_ENV=production AND the secret is unset', () => {
    const warning = cursorSecretBootWarning({ NODE_ENV: 'production' });
    expect(warning).not.toBeNull();
    expect(warning).toContain('PUBLIC_LISTING_CURSOR_SECRET');
    expect(warning).toContain('production');
    expect(warning).toContain('rotate before public launch');
  });

  it('warns when NODE_ENV=production AND the secret is blank/whitespace', () => {
    expect(
      cursorSecretBootWarning({ NODE_ENV: 'production', PUBLIC_LISTING_CURSOR_SECRET: '   ' }),
    ).not.toBeNull();
  });

  it('is silent when the secret IS set in production', () => {
    expect(
      cursorSecretBootWarning({
        NODE_ENV: 'production',
        PUBLIC_LISTING_CURSOR_SECRET: 'a-real-secret',
      }),
    ).toBeNull();
  });

  it('is silent outside production even when the secret is unset', () => {
    expect(cursorSecretBootWarning({ NODE_ENV: 'development' })).toBeNull();
    expect(cursorSecretBootWarning({ NODE_ENV: 'test' })).toBeNull();
    expect(cursorSecretBootWarning({})).toBeNull();
  });
});
