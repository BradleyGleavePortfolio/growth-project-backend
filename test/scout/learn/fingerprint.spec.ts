import { createHash } from 'crypto';
import {
  parseStructureDigest,
  structureKeyMatches,
  structureKeyOf,
  type StructureDigestV1,
} from '../../../src/scout/learn/digest-contract';
import {
  collectionStructureKeyStrings,
  reuseFingerprint,
  reuseMaterial,
} from '../../../src/scout/learn/fingerprint';
import { basicExample, clone, loadJson, REF } from './helpers';

interface Vector {
  name: string;
  digest: StructureDigestV1;
  validDigest: boolean;
  material: string[];
  fingerprint: string;
}

const vectors = loadJson<{ vectors: Vector[] }>('fingerprint-vectors.json').vectors;
const byName = new Map(vectors.map((v) => [v.name, v.fingerprint]));

describe('reuse fingerprint and structure keys (D-L0-3 r5; R591-B-B3)', () => {
  it.each(vectors.map((v) => [v.name, v] as const))(
    'shared vector %s: material and hash are byte-equal; validDigest flag holds',
    (_name, v) => {
      expect(reuseMaterial(v.digest)).toEqual(v.material);
      expect(v.fingerprint).toBe(
        createHash('sha256').update(v.material.join('\n'), 'utf8').digest('hex'),
      );
      expect(parseStructureDigest(v.digest).ok).toBe(v.validDigest);
    },
  );

  it('B3: optional-key marking, an added item key, an empty collection, ref order and non-collection templates never move the hash', () => {
    for (const same of [
      'two-collections-reordered-refs',
      'single-and-refused-ignored',
      'item-key-added-same',
      'optional-key-marked-same',
      'empty-collection-same',
    ])
      expect(byName.get(same)).toBe(byName.get('two-collections'));
    expect(byName.get('no-collections')).toBe(byName.get('empty'));
  });

  it('origin, template word and landing/explore discovery are the only inputs', () => {
    expect(byName.get('template-renamed-changes')).not.toBe(byName.get('two-collections'));
    expect(byName.get('origin-changes')).not.toBe(byName.get('two-collections'));
    expect(byName.get('explore-only-ignored')).not.toBe(byName.get('two-collections'));
    for (const v of vectors)
      for (const line of v.material) {
        expect(line).not.toMatch(/[0-9]{4}|@|https?:/);
        expect(JSON.parse(line)).toHaveLength(3);
      }
  });

  it('B3 (fail-first on 3a684671): removing an optional item key from the basic digest keeps the reuse fingerprint and the step still matches by structure key', () => {
    const base = basicExample().digest as Record<string, any>;
    const parsedBase = parseStructureDigest(base);
    if (!parsedBase.ok) throw new Error('fixture');
    const before = reuseFingerprint(parsedBase.value);
    const members = parsedBase.value.templates.find((t) => t.ref === REF.members)!;
    const fullKey = structureKeyOf(parsedBase.value, members);
    const sparse = clone(base);
    delete sparse.templates[1].shape.keys.members.items.keys.active;
    const parsedSparse = parseStructureDigest(sparse);
    expect(parsedSparse.ok).toBe(true);
    if (!parsedSparse.ok) return;
    expect(reuseFingerprint(parsedSparse.value)).toBe(before);
    const sparseKey = structureKeyOf(
      parsedSparse.value,
      parsedSparse.value.templates.find((t) => t.ref === REF.members)!,
    );
    expect(structureKeyMatches(fullKey, sparseKey)).toBe(true);
    // The other direction is not a match: a digest with MORE structure than the package step.
    expect(structureKeyMatches(sparseKey, fullKey)).toBe(false);
  });

  it('the reuse fingerprint refuses a round-2 digest (a union is never a reuse signal)', () => {
    const round2 = clone(basicExample().digest) as Record<string, unknown>;
    round2.round = 2;
    const parsed2 = parseStructureDigest(round2);
    expect(parsed2.ok).toBe(true);
    if (!parsed2.ok) return;
    expect(() => reuseFingerprint(parsed2.value)).toThrow(/round-1/);
  });

  it('is invariant under slot class/distinct, query distinct, statuses, observations, header names, link templates and pagination signals', () => {
    const base = basicExample().digest as Record<string, any>;
    const parsedBase = parseStructureDigest(base);
    if (!parsedBase.ok) throw new Error('fixture');
    const before = reuseFingerprint(parsedBase.value);
    const mutated = clone(base);
    mutated.templates[1].slots[0] = { slot: ':s1', class: 'uuid_like', distinct: '3+' };
    mutated.templates[1].queryKeys[0].distinct = '3+';
    mutated.templates[1].statuses = [200, 304];
    mutated.templates[1].observations = 99;
    mutated.templates[1].paginationSignals = ['cursor_key', 'has_more_key', 'next_link_key'];
    mutated.constantHeaderNames = [];
    mutated.linkTemplates = [];
    const parsed = parseStructureDigest(mutated);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(reuseFingerprint(parsed.value)).toBe(before);
  });

  it('collectionStructureKeyStrings lists the sorted structure keys of collection templates', () => {
    const parsed = parseStructureDigest(basicExample().digest);
    if (!parsed.ok) throw new Error('fixture');
    const keys = collectionStructureKeyStrings(parsed.value);
    expect(keys).toHaveLength(4);
    expect([...keys].sort()).toEqual(keys);
    for (const key of keys) expect(JSON.parse(key)).toHaveLength(4);
  });
});
