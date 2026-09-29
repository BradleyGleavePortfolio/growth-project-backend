import {
  DIGEST_MAX_BYTES,
  parseStructureDigest,
  structureKeyOf,
  structureKeyString,
} from '../../../src/scout/learn/digest-contract';
import { basicExample, clone, codesOf, loadJson } from './helpers';

type Raw = Record<string, any>;

function parse(raw: unknown) {
  return parseStructureDigest(raw);
}

function expectRefused(raw: unknown, pathFragment?: string): void {
  const result = parse(raw);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(codesOf(result)).toEqual(['V-L0']);
    if (pathFragment) expect(result.errors.some((e) => e.path.includes(pathFragment))).toBe(true);
  }
}

describe('StructureDigestV1 r3 parser (V-L0)', () => {
  it('accepts the basic example and freezes it', () => {
    const result = parse(basicExample().digest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(result.value.round).toBe(1);
    expect(result.value.templates.map((t) => t.ref)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(result.value.origins.map((o) => o.template)).toEqual([':d', 'api.:d']);
    expect(result.value.linkTemplates.map((l) => l.ref)).toEqual(['l0', 'l1']);
    expect(result.value.constantHeaderNames).toEqual(['accept']);
  });

  it('accepts every canonical shared vector digest', () => {
    const vectors = loadJson<{
      vectors: { name: string; digest: unknown; validDigest: boolean }[];
    }>('fingerprint-vectors.json').vectors;
    for (const v of vectors) {
      const result = parse(v.digest);
      if (!v.validDigest) expect(result.ok).toBe(false);
      else
        expect({ name: v.name, ok: result.ok, errors: result.ok ? [] : result.errors }).toEqual({
          name: v.name,
          ok: true,
          errors: [],
        });
    }
  });

  describe('grammar and bounds', () => {
    it('refuses non-objects, unknown and missing keys, wrong version', () => {
      expectRefused(null);
      expectRefused([]);
      const d = basicExample().digest as Raw;
      expectRefused({ ...d, extra: 1 }, 'extra');
      const { linkTemplates: _l, ...missing } = d;
      expectRefused(missing, 'linkTemplates');
      expectRefused({ ...d, digestVersion: 1 }, 'digestVersion');
    });

    it('refuses r2-era fields: slot hash, provenSlotHashes, header values, vocabularyVersion', () => {
      const d = basicExample().digest as Raw;
      const withHash = clone(d);
      withHash.templates[1].slots[0].hash = 'abcdef';
      expectRefused(withHash, 'slots');
      expectRefused({ ...clone(d), provenSlotHashes: [] });
      expectRefused({ ...clone(d), vocabularyVersion: 1 });
      const headers = clone(d);
      headers.constantHeaderNames = [{ accept: 'application/json' }];
      expectRefused(headers, 'constantHeaderNames');
      const headers2 = clone(d);
      headers2.constantHeaderNames = ['accept: application/json'];
      expectRefused(headers2, 'constantHeaderNames');
    });

    it('r5: the slug is NOT in the digest; missingFamilies (family labels) are round 2 only', () => {
      const d = basicExample().digest as Raw;
      expectRefused({ ...clone(d), sourcePlatform: 'example_alpha' }, 'sourcePlatform');
      expectRefused({ ...clone(d), missingFamilies: ['programs'] }, 'missingFamilies');
      expectRefused(
        { ...clone(d), round: 2, missingFamilies: ['not_a_family'] },
        'missingFamilies',
      );
      const r2 = clone(d);
      r2.round = 2;
      r2.missingFamilies = ['programs'];
      expect(parse(r2).ok).toBe(true);
      expectRefused({ ...clone(d), round: 3 }, 'round');
    });

    it('refuses more than 32 KiB', () => {
      const d = basicExample().digest as Raw;
      const big = clone(d);
      const keys: Record<string, unknown> = {};
      for (let i = 0; i < 60; i += 1)
        keys[`k${i}`] = { kind: 'string', class: 'text', lengthBucket: '≤256' };
      // many templates with wide objects: exceed the byte bound
      const base = big.templates[3];
      for (let i = 0; i < 60; i += 1) {
        big.templates.push({
          ...clone(base),
          ref: `t${4 + i}`,
          template: `/v2/me/${'items/'.repeat(1)}${'x'.repeat(0)}`,
          shape: { kind: 'object', keys: clone(keys), corroborated: Object.keys(keys) },
        });
      }
      const text = JSON.stringify(big);
      expect(text.length).toBeGreaterThan(DIGEST_MAX_BYTES);
      expectRefused(big);
    });
  });

  describe('templates', () => {
    it('requires canonical order and canonical refs', () => {
      const d = basicExample().digest as Raw;
      const swapped = clone(d);
      [swapped.templates[0], swapped.templates[1]] = [swapped.templates[1], swapped.templates[0]];
      expectRefused(swapped);
      const renamed = clone(d);
      renamed.templates[0].ref = 't9';
      expectRefused(renamed, 'ref');
    });

    it.each([
      'https://host.example/api/clients',
      '//host.example/api/clients',
      'api/clients',
      '/api/clients?page=1',
      '/api/clients#x',
      '/api/:s1=acme/clients',
      '/api/:s/clients',
      '/api/clients/:p',
      '/api/clients/${process.env.TOKEN}',
      '/api/clients%2F..%2Fadmin',
      '/api/clients/',
      '/api//clients',
      '/api/acme-fitness/clients',
      '/api/4821/clients',
      '/api/u20240101/clients',
      '/api/coach@example.com/clients',
      '/api/клиенты',
    ])('refuses template %s', (template) => {
      const d = basicExample().digest as Raw;
      d.templates[2].template = template;
      expectRefused(d);
    });

    it('requires every :sN of the template to have exactly one typed slot entry and no others', () => {
      const d = basicExample().digest as Raw;
      const missing = clone(d);
      missing.templates[1].slots = [];
      expectRefused(missing, 'slots');
      const extra = clone(d);
      extra.templates[1].slots.push({ slot: ':s2', class: 'opaque', distinct: 1 });
      expectRefused(extra, 'slots');
      const badClass = clone(d);
      badClass.templates[1].slots[0].class = 'email_like';
      expectRefused(badClass, 'slots');
    });

    it('refuses query keys outside the grammar or credential-like, and duplicates', () => {
      const d = basicExample().digest as Raw;
      for (const key of ['access_token', 'auth', 'user@', 'v20240101', 'page number', 'page=2']) {
        const c = clone(d);
        c.templates[1].queryKeys = [{ key, distinct: 1 }];
        expectRefused(c, 'queryKeys');
      }
      const dup = clone(d);
      dup.templates[1].queryKeys = [
        { key: 'after', distinct: 1 },
        { key: 'after', distinct: 2 },
      ];
      expectRefused(dup, 'queryKeys');
      const value = clone(d);
      value.templates[1].queryKeys = [{ key: 'after', distinct: 1, values: ['x'] }];
      expectRefused(value, 'queryKeys');
    });

    it('requires refusedKind exactly when role is refused and collectionPaths only for collections', () => {
      const d = basicExample().digest as Raw;
      const single = clone(d);
      single.templates[2].refusedKind = 'not_collection';
      expectRefused(single, 'refusedKind');
      const refused = clone(d);
      refused.templates[2].role = 'refused';
      expectRefused(refused, 'refusedKind');
      refused.templates[2].refusedKind = 'collection_unproven';
      expect(parse(refused).ok).toBe(true);
      const paths = clone(d);
      paths.templates[2].collectionPaths = [['x']];
      expectRefused(paths, 'collectionPaths');
      const noPaths = clone(d);
      noPaths.templates[1].collectionPaths = [];
      expectRefused(noPaths, 'collectionPaths');
      const badPath = clone(d);
      badPath.templates[1].collectionPaths = [['nope']];
      expectRefused(badPath, 'collectionPaths');
    });

    it('refuses duplicate template keys', () => {
      const d = basicExample().digest as Raw;
      const t = clone(d.templates[2]);
      t.ref = 't3';
      d.templates.splice(3, 0, t);
      d.templates[4].ref = 't4';
      expectRefused(d);
    });
  });

  describe('shapes and key admission (r4)', () => {
    it('refuses containers beyond depth 4 and accepts depth 4', () => {
      const d = basicExample().digest as Raw;
      const deep = clone(d);
      let node: Raw = deep.templates[2].shape;
      for (let i = 0; i < 5; i += 1) {
        node.keys.items = { kind: 'object', keys: {} };
        node = node.keys.items;
      }
      expectRefused(deep, 'shape');
      const ok = clone(d);
      node = ok.templates[2].shape;
      for (let i = 0; i < 4; i += 1) {
        node.keys.items = { kind: 'object', keys: {} };
        node = node.keys.items;
      }
      expect(parse(ok).ok).toBe(true);
    });

    it('refuses an uncorroborated non-vocabulary key and admits a corroborated one', () => {
      const d = basicExample().digest as Raw;
      const item = d.templates[1].shape.keys.members.items;
      item.keys.favourite_colour = { kind: 'string', class: 'text', lengthBucket: '≤32' };
      expectRefused(clone(d), 'favourite_colour');
      item.corroborated = ['favourite_colour'];
      expect(parse(d).ok).toBe(true);
    });

    it('refuses corroborated entries that are not keys of the object', () => {
      const d = basicExample().digest as Raw;
      d.templates[1].shape.keys.members.items.corroborated = ['ghost'];
      expectRefused(d, 'corroborated');
    });

    it('refuses credential-like keys even when corroborated', () => {
      for (const key of [
        'access_token',
        'client_secret',
        'passwd_hash',
        'Authorization',
        'sessionId',
        'cookie_jar',
        'apiKey',
        'sig_signature',
        'BearerValue',
      ]) {
        const d = basicExample().digest as Raw;
        const item = d.templates[1].shape.keys.members.items;
        item.keys[key] = { kind: 'string', class: 'text', lengthBucket: '≤32' };
        item.corroborated = [key];
        expectRefused(d);
      }
    });

    it('refuses keys outside the identifier grammar even when corroborated', () => {
      for (const key of [
        'display name',
        'coach@example',
        'member_20240101',
        'a'.repeat(49),
        'displаy_name',
        'display\u200bname',
        '<script>',
        '$ref',
        'a.b',
        '',
      ]) {
        const d = basicExample().digest as Raw;
        const item = d.templates[1].shape.keys.members.items;
        item.keys[key] = { kind: 'boolean' };
        item.corroborated = [key];
        expectRefused(d);
      }
    });

    it('accepts map nodes and refuses map nodes carrying keys', () => {
      const d = basicExample().digest as Raw;
      d.templates[2].shape.keys.by_day = {
        kind: 'map',
        keyClass: 'iso_date',
        sizeBucket: '2-9',
        values: { kind: 'number', class: 'int' },
      };
      expect(parse(clone(d)).ok).toBe(true);
      d.templates[2].shape.keys.by_day.keys = { a: { kind: 'boolean' } };
      expectRefused(d, 'by_day');
    });

    it('refuses scalar nodes carrying sample values', () => {
      const d = basicExample().digest as Raw;
      d.templates[2].shape.keys.id = {
        kind: 'string',
        class: 'int_id',
        lengthBucket: '≤8',
        sample: '4821',
      };
      expectRefused(d, 'id');
    });
  });

  describe('link templates', () => {
    it('requires sorted refs, root-relative vocabulary templates and a captured flag', () => {
      const d = basicExample().digest as Raw;
      const unsorted = clone(d);
      [unsorted.linkTemplates[0], unsorted.linkTemplates[1]] = [
        unsorted.linkTemplates[1],
        unsorted.linkTemplates[0],
      ];
      expectRefused(unsorted, 'linkTemplates');
      const abs = clone(d);
      abs.linkTemplates[0].template = 'https://host.example/coach/:p1/programs';
      expectRefused(abs, 'linkTemplates');
      const tenant = clone(d);
      tenant.linkTemplates[0].template = '/coach/acme/programs';
      expectRefused(tenant, 'linkTemplates');
      const noFlag = clone(d);
      delete noFlag.linkTemplates[0].captured;
      expectRefused(noFlag, 'linkTemplates');
    });
  });

  it('structure key is (origin, method, template, required keyPaths) and stable across ref renumbering', () => {
    const result = parse(basicExample().digest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const key = structureKeyOf(result.value, result.value.templates[1]);
    expect(key.origin).toBe(':d');
    expect(key.method).toBe('GET');
    expect(key.template).toBe('/v2/coaches/:s1/members');
    expect(key.keyPaths).toContain('members[].display_name');
    expect(key.keyPaths).toContain('meta.next');
    expect(JSON.parse(structureKeyString(key))).toHaveLength(4);
    expect(structureKeyOf(result.value, { ...result.value.templates[1], ref: 't7' })).toEqual(key);
  });
});
