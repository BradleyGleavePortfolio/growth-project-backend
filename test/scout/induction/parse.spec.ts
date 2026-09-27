import {
  checkObservationBodySize,
  decodeBase64Strict,
  ed25519PublicKey,
  parseEvidence,
  parseIssuedAt,
  parseStatementBytes,
} from '../../../src/scout/induction/parse';
import {
  canonicalStatementBytes,
  evidenceFor,
  referenceIdDigest,
  sha256,
  signBytes,
  TEST_KEYS,
} from '../../fixtures/scout/s10_pure/s10-pure-signer';

/**
 * S10-A R21 (parser tier) — every untrusted artifact is refused on the first grammar,
 * encoding or bound violation, with a result (never a throw). The positive case proves the
 * refusals are not vacuous: the same builder with no override parses.
 */

const SCOPE = sha256('scope-1');
const CHALLENGE = Buffer.alloc(32, 7);
const SPEC_DIGEST = sha256('spec');

function statement(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    statement_version: 1,
    source_platform: 's10_unseen',
    account_scope_id_digest: SCOPE,
    family: 'clients',
    challenge_b64: CHALLENGE.toString('base64'),
    snapshot_ref_digest: sha256('snapshot-ref'),
    date_window: null,
    terminal: 'end_of_list',
    observed_unique: 2,
    id_set_digest: referenceIdDigest(['a', 'b']),
    issued_at: '2026-09-26T10:00:00Z',
    ...over,
  };
}

function statementReason(bytes: Buffer): string | null {
  const result = parseStatementBytes(bytes);
  return result.ok ? null : result.reason;
}

function evidenceReason(raw: unknown): string | null {
  const result = parseEvidence(raw);
  return result.ok ? null : result.reason;
}

describe('R21 — statement strict canonical JSON', () => {
  it('parses a canonical statement (positive control)', () => {
    const result = parseStatementBytes(canonicalStatementBytes(statement()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.statement.observed_unique).toBe(2);
    expect(result.value.challenge.equals(CHALLENGE)).toBe(true);
    expect(result.value.issuedAt.floorMs).toBe(Date.UTC(2026, 8, 26, 10, 0, 0));
  });

  it('refuses unknown, extra and missing keys and a wrong version', () => {
    expect(statementReason(canonicalStatementBytes(statement({ zz_extra: 1 })))).toBe(
      'unknown_key',
    );
    const missing = statement();
    delete missing.terminal;
    expect(statementReason(canonicalStatementBytes(missing))).toBe('missing_key');
    expect(statementReason(canonicalStatementBytes(statement({ statement_version: 2 })))).toBe(
      'bad_version',
    );
  });

  it('refuses unsorted keys, insignificant whitespace, a BOM and a duplicate key', () => {
    const canonical = canonicalStatementBytes(statement()).toString('utf8');
    const unsorted = Buffer.from(JSON.stringify({ terminal: 'end_of_list', ...statement() }));
    expect(statementReason(unsorted)).toBe('non_canonical_json');
    expect(statementReason(Buffer.from(JSON.stringify(statement(), null, 1)))).toBe(
      'non_canonical_json',
    );
    expect(statementReason(Buffer.from(canonical.replace('{', '{ ')))).toBe('non_canonical_json');
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical)]);
    expect(statementReason(bom)).toBe('non_canonical_json');
    const first = canonical.slice(1, canonical.indexOf(',') + 1);
    expect(statementReason(Buffer.from(`{${first}${canonical.slice(1)}`))).toBe(
      'non_canonical_json',
    );
  });

  it('refuses non-integer numbers, non-minimal escapes and invalid UTF-8', () => {
    const canonical = canonicalStatementBytes(statement()).toString('utf8');
    expect(
      statementReason(
        Buffer.from(canonical.replace('"observed_unique":2', '"observed_unique":2.0')),
      ),
    ).toBe('non_canonical_json');
    expect(statementReason(canonicalStatementBytes(statement({ observed_unique: 1.5 })))).toBe(
      'non_canonical_json',
    );
    expect(
      statementReason(Buffer.from(canonical.replace('end_of_list', 'end\\u005fof_list'))),
    ).toBe('non_canonical_json');
    expect(statementReason(Buffer.from([0x7b, 0xff, 0x7d]))).toBe('non_canonical_json');
  });

  it('refuses a statement over 1024 bytes', () => {
    const big = Buffer.alloc(1025, 0x20);
    expect(statementReason(big)).toBe('too_large');
  });

  it('refuses non-hex digests, a bad count, a wrong-length challenge and bad literals', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ snapshot_ref_digest: 'g'.repeat(64) }, 'bad_digest'],
      [{ snapshot_ref_digest: 'a'.repeat(63) }, 'bad_digest'],
      [{ id_set_digest: 'A'.repeat(64) }, 'bad_digest'],
      [{ account_scope_id_digest: 'raw-scope-id' }, 'bad_digest'],
      [{ observed_unique: -1 }, 'bad_count'],
      [{ observed_unique: 2 ** 31 }, 'bad_count'],
      [{ challenge_b64: Buffer.alloc(31, 7).toString('base64') }, 'bad_length'],
      [{ challenge_b64: Buffer.alloc(33, 7).toString('base64') }, 'bad_length'],
      [{ challenge_b64: CHALLENGE.toString('base64').replace(/=+$/, '') }, 'bad_base64'],
      [{ date_window: { from: '2026-01-01' } }, 'bad_date_window'],
      [{ terminal: 'page' }, 'bad_terminal'],
      [{ family: 'billing' }, 'bad_family'],
      [{ source_platform: 'Not Canonical' }, 'bad_platform'],
    ];
    for (const [over, reason] of cases) {
      expect([over, statementReason(canonicalStatementBytes(statement(over)))]).toEqual([
        over,
        reason,
      ]);
    }
    expect(
      statementReason(canonicalStatementBytes(statement({ observed_unique: 2 ** 31 - 1 }))),
    ).toBeNull();
    expect(statementReason(canonicalStatementBytes(statement({ observed_unique: 0 })))).toBeNull();
  });

  it('refuses issued_at that is not RFC 3339 UTC', () => {
    for (const issued of [
      '2026-09-26T10:00:00+00:00',
      '2026-09-26T10:00:00',
      '2026-09-26 10:00:00Z',
      '2026-09-26t10:00:00z',
      '2026-02-30T10:00:00Z',
      '2026-09-26T24:00:00Z',
      '2026-09-26T10:00:60Z',
      '2026-09-26T10:00:00.1234567890Z',
      1790000000,
    ]) {
      expect([
        issued,
        statementReason(canonicalStatementBytes(statement({ issued_at: issued }))),
      ]).toEqual([issued, 'bad_issued_at']);
    }
  });

  it('bounds sub-millisecond instants conservatively', () => {
    expect(parseIssuedAt('2026-09-26T10:00:00.1234Z')).toEqual({
      floorMs: Date.UTC(2026, 8, 26, 10, 0, 0, 123),
      ceilMs: Date.UTC(2026, 8, 26, 10, 0, 0, 124),
    });
    expect(parseIssuedAt('2026-09-26T10:00:00.5Z')).toEqual({
      floorMs: Date.UTC(2026, 8, 26, 10, 0, 0, 500),
      ceilMs: Date.UTC(2026, 8, 26, 10, 0, 0, 500),
    });
  });
});

describe('R21 — strict RFC 4648 base64', () => {
  it('accepts canonical base64 and refuses whitespace, missing padding, URL alphabet and pad bits', () => {
    expect(decodeBase64Strict('QQ==')?.toString('utf8')).toBe('A');
    expect(decodeBase64Strict('QUJD')?.toString('utf8')).toBe('ABC');
    for (const text of ['QQ', 'QQ=', ' QQ==', 'QQ==\n', 'Q Q==', '-_8=', 'QR==', 'QUJ=', 42]) {
      expect([text, decodeBase64Strict(text)]).toEqual([text, null]);
    }
  });

  it('imports only a 32-byte Ed25519 public key', () => {
    const good = Buffer.from(TEST_KEYS.source.public_key_b64, 'base64');
    expect(ed25519PublicKey(good)?.asymmetricKeyType).toBe('ed25519');
    expect(ed25519PublicKey(good.subarray(0, 31))).toBeNull();
    expect(ed25519PublicKey(Buffer.concat([good, Buffer.alloc(1)]))).toBeNull();
  });
});

describe('R21 — observation evidence', () => {
  const good = (): Record<string, unknown> => evidenceFor(statement(), SPEC_DIGEST);

  it('parses valid evidence and exposes the DECODED statement bytes (positive control)', () => {
    const result = parseEvidence(good());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.statementBytes.equals(canonicalStatementBytes(statement()))).toBe(true);
    expect(result.value.signature.length).toBe(64);
  });

  it('refuses unknown keys, versions, digests, basis kinds (incl. page-chain) and key ids', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ extra: true }, 'unknown_key'],
      [{ evidence_version: 2 }, 'bad_version'],
      [{ mapping_spec_digest: 'x'.repeat(64) }, 'bad_digest'],
      [{ account_scope_id_digest: SCOPE.toUpperCase() }, 'bad_digest'],
      [{ basis_kind: 'none' }, 'unknown_basis_kind'],
      [{ basis_kind: 'source_signed_page_chain' }, 'unknown_basis_kind'],
      [{ basis_kind: 'extension_asserted' }, 'unknown_basis_kind'],
      [{ key_id: 'Upper.Case' }, 'bad_key_id'],
      [{ key_id: 'k'.repeat(65) }, 'bad_key_id'],
      [{ family: 'messages' }, 'bad_family'],
    ];
    for (const [over, reason] of cases) {
      expect([over, evidenceReason({ ...good(), ...over })]).toEqual([over, reason]);
    }
    const missing = good();
    delete missing.signature_b64;
    expect(evidenceReason(missing)).toBe('missing_key');
    expect(evidenceReason('not an object')).toBe('not_object');
    expect(evidenceReason([good()])).toBe('not_object');
  });

  it('refuses non-canonical base64 and wrong-length signatures', () => {
    const sig = String(good().signature_b64);
    expect(
      evidenceReason({ ...good(), signature_b64: `${sig.slice(0, 40)}\n${sig.slice(40)}` }),
    ).toBe('bad_base64');
    expect(evidenceReason({ ...good(), signature_b64: sig.replace(/=+$/, '') })).toBe('bad_base64');
    const urlSafe = String(good().statement_b64).replace(/\+/g, '-').replace(/\//g, '_');
    if (urlSafe !== good().statement_b64) {
      expect(evidenceReason({ ...good(), statement_b64: urlSafe })).toBe('bad_base64');
    }
    expect(evidenceReason({ ...good(), statement_b64: '-_-_' })).toBe('bad_base64');
    expect(evidenceReason({ ...good(), signature_b64: Buffer.alloc(63).toString('base64') })).toBe(
      'bad_length',
    );
    expect(evidenceReason({ ...good(), signature_b64: Buffer.alloc(65).toString('base64') })).toBe(
      'bad_length',
    );
  });

  it('refuses an oversized statement before decoding it and a non-canonical embedded statement', () => {
    const big = Buffer.alloc(1100, 0x61).toString('base64');
    expect(evidenceReason({ ...good(), statement_b64: big })).toBe('too_large');
    const spaced = Buffer.from(JSON.stringify(statement(), null, 2));
    expect(evidenceReason(evidenceFor(statement(), SPEC_DIGEST, { statementBytes: spaced }))).toBe(
      'non_canonical_json',
    );
  });
});

describe('R21 — observation body size bound', () => {
  it('accepts exactly 32768 bytes and refuses 32769 as too_large', () => {
    expect(checkObservationBodySize(32768)).toEqual({ ok: true, value: 32768 });
    expect(checkObservationBodySize(32769)).toEqual({ ok: false, reason: 'too_large' });
    expect(checkObservationBodySize(Buffer.byteLength('é'.repeat(16385), 'utf8'))).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('refuses non-integer or negative lengths without throwing', () => {
    for (const n of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(checkObservationBodySize(n)).toEqual({ ok: false, reason: 'bad_length' });
    }
  });
});

describe('R21 — parser totality', () => {
  it('never throws on hostile input', () => {
    for (const raw of [null, 0, 'x', [], {}, { evidence_version: 1 }]) {
      expect(() => parseEvidence(raw)).not.toThrow();
    }
    expect(signBytes(Buffer.from('x')).length).toBe(64);
  });
});
