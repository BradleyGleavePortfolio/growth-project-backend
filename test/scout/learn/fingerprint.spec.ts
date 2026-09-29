import { createHash } from 'crypto';
import {
  parseStructureDigest,
  type StructureDigestV1,
} from '../../../src/scout/learn/digest-contract';
import {
  FINGERPRINT_SHAPE_DEPTH,
  collectionTemplateKeys,
  fingerprintFull,
  fingerprintMaterial,
  fingerprintR1,
  itemShapeSignature,
  shapeSignature,
  structureFingerprint,
} from '../../../src/scout/learn/fingerprint';
import { basicExample, clone, loadJson } from './helpers';

interface Vector {
  name: string;
  digest: StructureDigestV1;
  material: string[];
  fingerprint: string;
}

const vectors = loadJson<{ vectors: Vector[] }>('fingerprint-vectors.json').vectors;

describe('structure fingerprint (D-L0-5 r3: fingerprint_r1 / fingerprint_full over the slotted form)', () => {
  it.each(vectors.map((v) => [v.name, v] as const))(
    'shared vector %s: material and hash are byte-equal',
    (_name, v) => {
      expect(fingerprintMaterial(v.digest)).toEqual(v.material);
      expect(structureFingerprint(v.digest)).toBe(v.fingerprint);
      expect(v.fingerprint).toBe(
        createHash('sha256').update(v.material.join('\n'), 'utf8').digest('hex'),
      );
    },
  );

  it('ref order, singles and refused templates never enter the material', () => {
    const byName = new Map(vectors.map((v) => [v.name, v.fingerprint]));
    expect(byName.get('two-collections-reordered-refs')).toBe(byName.get('two-collections'));
    expect(byName.get('single-and-refused-ignored')).toBe(byName.get('two-collections'));
    expect(byName.get('no-collections')).toBe(byName.get('empty'));
  });

  it('an item key added or a template word changed moves the hash; the hash is of the slotted form', () => {
    const byName = new Map(vectors.map((v) => [v.name, v.fingerprint]));
    expect(byName.get('item-key-added-changes')).not.toBe(byName.get('two-collections'));
    expect(byName.get('template-renamed-changes')).not.toBe(byName.get('two-collections'));
    for (const v of vectors)
      for (const line of v.material) expect(line).not.toMatch(/[0-9]{4}|@|https?:/);
  });

  it('fingerprint_r1 refuses a round-2 digest; fingerprint_full accepts both and equals the same function', () => {
    const parsed = parseStructureDigest(basicExample().digest);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const r1 = fingerprintR1(parsed.value);
    expect(r1).toBe(structureFingerprint(parsed.value));
    expect(fingerprintFull(parsed.value)).toBe(r1);
    const round2 = clone(basicExample().digest) as Record<string, unknown>;
    round2.round = 2;
    const parsed2 = parseStructureDigest(round2);
    expect(parsed2.ok).toBe(true);
    if (!parsed2.ok) return;
    expect(() => fingerprintR1(parsed2.value)).toThrow(/round-1/);
    expect(fingerprintFull(parsed2.value)).toBe(r1);
  });

  it('is invariant under slot class/distinct, query distinct, statuses, observations, header names, link templates and sourcePlatform', () => {
    const base = basicExample().digest as Record<string, any>;
    const parsedBase = parseStructureDigest(base);
    if (!parsedBase.ok) throw new Error('fixture');
    const before = structureFingerprint(parsedBase.value);
    const mutated = clone(base);
    mutated.sourcePlatform = 'other_site';
    mutated.templates[1].slots[0] = { slot: ':s1', class: 'uuid_like', distinct: '3+' };
    mutated.templates[1].queryKeys[0].distinct = '3+';
    mutated.templates[1].statuses = [200, 304];
    mutated.templates[1].observations = 99;
    mutated.constantHeaderNames = [];
    mutated.linkTemplates = [];
    mutated.round = 2;
    mutated.missingFamilies = ['programs'];
    const parsed = parseStructureDigest(mutated);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(structureFingerprint(parsed.value)).toBe(before);
  });

  it('shapeSignature is kinds-only at depth 2 and is the item signature', () => {
    expect(FINGERPRINT_SHAPE_DEPTH).toBe(2);
    expect(itemShapeSignature).toBe(shapeSignature);
    const node = {
      kind: 'object' as const,
      keys: {
        a: { kind: 'string' as const, class: 'text' as const, lengthBucket: '≤8' as const },
        b: {
          kind: 'array' as const,
          lengthBucket: '1' as const,
          items: { kind: 'object' as const, keys: { c: { kind: 'boolean' as const } } },
        },
      },
    };
    expect(shapeSignature(node)).toBe('object{array[object(*)]*1,string*1}');
    // Key names never enter the signature: a rename is not a structural change (L02).
    const renamed = { ...node, keys: { z: node.keys.a, b: node.keys.b } };
    expect(shapeSignature(renamed)).toBe(shapeSignature(node));
    const added = { ...node, keys: { ...node.keys, c: { kind: 'boolean' as const } } };
    expect(shapeSignature(added)).not.toBe(shapeSignature(node));
  });

  it('collectionTemplateKeys lists the sorted keys of collection templates', () => {
    const parsed = parseStructureDigest(basicExample().digest);
    if (!parsed.ok) throw new Error('fixture');
    const keys = collectionTemplateKeys(parsed.value);
    expect(keys).toHaveLength(3);
    expect([...keys].sort()).toEqual(keys);
  });
});
