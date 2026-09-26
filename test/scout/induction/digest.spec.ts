import { readFileSync } from 'fs';
import {
  canonicalJson,
  EMPTY_IDENTITY_SET_DIGEST,
  identitySetDigest,
  mappingSpecDigest,
  stagedFamilyDigests,
} from '../../../src/scout/induction/digest';
import { parseSourceMappingSpec } from '../../../src/scout/reconstruct/mapping-spec';
import {
  referenceIdDigest,
  S10_PURE_SPEC_PATH,
  sha256,
} from '../../fixtures/scout/s10_pure/s10-pure-signer';

/**
 * S10-A — D-S10-2 identity digest and spec digest. Expected values come from an independent
 * reference encoder (fixture helper) or from hand-built byte strings, never from the
 * implementation under test.
 */

describe('identitySetDigest (D-S10-2)', () => {
  it('digests the empty set as sha256("") with count 0 (R26 input)', () => {
    expect(EMPTY_IDENTITY_SET_DIGEST).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(identitySetDigest([])).toEqual({ digest: EMPTY_IDENTITY_SET_DIGEST, count: 0 });
  });

  it('is sha256 over bytewise-sorted distinct `<utf8-byte-length>:<id>` records', () => {
    expect(identitySetDigest(['b', 'a', 'b'])).toEqual({ digest: sha256('1:a1:b'), count: 2 });
    // UTF-8 byte length, not UTF-16 length: 'é' is 2 bytes.
    expect(identitySetDigest(['é'])?.digest).toBe(sha256('2:é'));
    const ids = ['z-9', 'Z-9', 'ü', '10', '9', 'x'.repeat(300)];
    expect(identitySetDigest(ids)).toEqual({ digest: referenceIdDigest(ids), count: 6 });
  });

  it('sorts bytewise (UTF-8), not by UTF-16 code unit', () => {
    // U+FF5E (EF BD 9E) sorts before U+1F600 (F0 9F 98 80) in UTF-8 but after it in UTF-16.
    const ids = ['\u{1F600}', '\uFF5E'];
    expect(identitySetDigest(ids)?.digest).toBe(sha256(`3:\uFF5E4:\u{1F600}`));
  });

  it('is order-independent and length-prefix-unambiguous', () => {
    expect(identitySetDigest(['x', 'y'])).toEqual(identitySetDigest(['y', 'x']));
    expect(identitySetDigest(['ab', 'c'])?.digest).not.toBe(identitySetDigest(['a', 'bc'])?.digest);
    expect(identitySetDigest(['1:a'])?.digest).not.toBe(identitySetDigest(['a'])?.digest);
  });

  it('refuses ids with no UTF-8 encoding (lone surrogates) instead of colliding them', () => {
    expect(identitySetDigest(['\uD800'])).toBeNull();
    expect(identitySetDigest(['ok', '\uDC00x'])).toBeNull();
  });
});

describe('stagedFamilyDigests (E6 staged side)', () => {
  it('digests each pre-grouped family and poisons a family grouped twice', () => {
    const out = stagedFamilyDigests([
      ['clients', ['c1', 'c2']],
      ['workouts', []],
      ['programs', ['p1']],
      ['programs', ['p2']],
    ]);
    expect(out.get('clients')).toEqual({ digest: referenceIdDigest(['c1', 'c2']), count: 2 });
    expect(out.get('workouts')).toEqual({ digest: EMPTY_IDENTITY_SET_DIGEST, count: 0 });
    expect(out.get('programs')).toBeNull();
  });
});

describe('canonicalJson and mappingSpecDigest', () => {
  it('sorts keys, drops whitespace and refuses non-JSON values', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x"\n'] })).toBe(
      '{"a":[true,null,"x\\"\\n"],"b":1}',
    );
    expect(canonicalJson({ a: 1.5 })).toBeNull();
    expect(canonicalJson({ a: undefined })).toBeNull();
    expect(canonicalJson(-0)).toBeNull();
    expect(canonicalJson(new Date(0))).toBeNull();
    expect(canonicalJson('\uD800')).toBeNull();
  });

  it('digests the loaded spec canonically and changes with any spec byte', () => {
    const raw = JSON.parse(readFileSync(S10_PURE_SPEC_PATH, 'utf8'));
    const spec = parseSourceMappingSpec(raw, 's10_unseen.json');
    const reordered = parseSourceMappingSpec(
      {
        families: raw.families,
        steps: raw.steps,
        sharedIdSpaces: raw.sharedIdSpaces,
        sourcePlatform: raw.sourcePlatform,
        specVersion: 1,
      },
      'reordered.json',
    );
    expect(mappingSpecDigest(spec)).toMatch(/^[0-9a-f]{64}$/);
    expect(mappingSpecDigest(reordered)).toBe(mappingSpecDigest(spec));
    const changed = parseSourceMappingSpec(
      {
        ...raw,
        families: {
          ...raw.families,
          clients: { displayName: { paths: [['full_name']], coerce: 'string' } },
        },
      },
      'changed.json',
    );
    expect(mappingSpecDigest(changed)).not.toBe(mappingSpecDigest(spec));
  });
});
