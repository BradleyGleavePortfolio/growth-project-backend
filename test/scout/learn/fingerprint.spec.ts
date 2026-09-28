import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import {
  filterVariantKeys,
  parseStructureDigest,
  unexploredLinkTemplates,
  type StructureDigestV1,
} from '../../../src/scout/learn/digest-contract';
import {
  fingerprintMaterial,
  itemShapeSignature,
  structureFingerprint,
} from '../../../src/scout/learn/fingerprint';

// L02 (D-L0-5 "Fingerprint"): order-independent, ignores ids, keys and values, changes when a
// collection template or its item kinds change, byte-equal to the extension's shared vectors
// (tgp-importer-extension x2/learn-digest-compile 055b5e6, test/fixtures/learn/fingerprint-vectors.json;
// sourcePlatform neutralised here, it never enters the material).

interface Vector {
  name: string;
  digest: unknown;
  material: string[];
  fingerprint: string;
}
interface Vectors {
  vectors: Vector[];
}

const VECTORS: Vectors = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/scout/learn/fingerprint-vectors.json'), 'utf8'),
);
const EXAMPLE: { digest: unknown } = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/scout/learn/examples/basic.json'), 'utf8'),
);

function vectorOf(name: string): Vector {
  const vector = VECTORS.vectors.find((v) => v.name === name);
  if (!vector) throw new Error(`no vector ${name}`);
  return vector;
}

function digestOf(name: string): StructureDigestV1 {
  const parsed = parseStructureDigest(vectorOf(name).digest);
  if (!parsed.ok) throw new Error(`vector ${name} fails V-L0: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

// Hand-authored by X2 beyond the D-L0-2 depth bound (a container at depth 6); neither builder
// emits it, so V-L0 refuses it and the material is checked over the raw shape.
const OVER_DEPTH = 'depth-two-cutoff-and-bare-array';

describe('structure fingerprint (L02)', () => {
  it('every shared vector reproduces the extension material and fingerprint byte for byte', () => {
    expect(VECTORS.vectors.length).toBe(9);
    for (const vector of VECTORS.vectors) {
      expect(vector.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      const digest =
        vector.name === OVER_DEPTH ? (vector.digest as StructureDigestV1) : digestOf(vector.name);
      expect(fingerprintMaterial(digest)).toEqual(vector.material);
      expect(structureFingerprint(digest)).toBe(vector.fingerprint);
      expect(createHash('sha256').update(vector.material.join('\n'), 'utf8').digest('hex')).toBe(
        vector.fingerprint,
      );
    }
  });

  it('every vector but the over-depth one is a valid StructureDigestV1 (X2 form)', () => {
    for (const vector of VECTORS.vectors) {
      const parsed = parseStructureDigest(vector.digest);
      if (vector.name === OVER_DEPTH) {
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.errors.map((e) => e.detail)).toEqual(['shape deeper than 4']);
      } else expect(parsed.ok).toBe(true);
    }
  });

  it('is order-independent and ignores refs, single and refused templates', () => {
    const base = structureFingerprint(digestOf('two-collections'));
    expect(structureFingerprint(digestOf('two-collections-reordered-refs'))).toBe(base);
    expect(structureFingerprint(digestOf('single-and-refused-ignored'))).toBe(base);
  });

  it('changes when a collection template or its item kinds change', () => {
    const base = structureFingerprint(digestOf('two-collections'));
    expect(structureFingerprint(digestOf('item-key-added-changes'))).not.toBe(base);
    expect(structureFingerprint(digestOf('template-renamed-changes'))).not.toBe(base);
  });

  it('is computed over the slotted form: a session slot in a template changes the fingerprint (L0 r3)', () => {
    const raw = JSON.parse(JSON.stringify(EXAMPLE.digest)) as {
      templates: { template: string; structural: number[] }[];
    };
    const literal = parseStructureDigest(raw);
    raw.templates[0].template = '/v2/:s1/coaches/:s2/members';
    raw.templates[0].structural = [0, 2, 4];
    const slotted = parseStructureDigest(raw);
    expect(literal.ok && slotted.ok).toBe(true);
    if (!literal.ok || !slotted.ok) return;
    expect(structureFingerprint(slotted.value)).not.toBe(structureFingerprint(literal.value));
    expect(fingerprintMaterial(slotted.value)[0]).toContain(':s1');
  });

  it('a digest with no collection template hashes the empty string', () => {
    expect(structureFingerprint(digestOf('no-collections'))).toBe(
      createHash('sha256').update('').digest('hex'),
    );
    expect(structureFingerprint(digestOf('empty'))).toBe(
      createHash('sha256').update('').digest('hex'),
    );
  });

  it('itemShapeSignature carries kinds and counts only: never a key name, class, bucket or value', () => {
    const leafy = itemShapeSignature({
      kind: 'object',
      keys: {
        b: { kind: 'string', class: 'email_like', lengthBucket: '>256' },
        a: {
          kind: 'object',
          keys: { deep: { kind: 'object', keys: { x: { kind: 'boolean' } } } },
        },
        c: { kind: 'string', class: 'text', lengthBucket: '≤8' },
        m: { kind: 'map', values: { kind: 'number', class: 'int' } },
      },
    });
    expect(leafy).toBe('object{map[number]*1,object{object(*)*1}*1,string*2}');
    expect(leafy).not.toMatch(/email|deep|≤|>256/);
    expect(
      itemShapeSignature({ kind: 'array', items: { kind: 'null' }, lengthBucket: '0' }, 2),
    ).toBe('array(*)');
  });

  it('the vectors are value-free: no email, no digit run, no scheme, no credential name, no vendor host', () => {
    const text = JSON.stringify(VECTORS.vectors.map((v) => v.digest));
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/https?:/);
    expect(text).not.toMatch(/[0-9]{4}/);
    expect(text).not.toMatch(/authorization|cookie/i);
  });
});

describe('V-L0 digest parse (L01, refusing cases)', () => {
  const valid = (): Record<string, unknown> => JSON.parse(JSON.stringify(EXAMPLE.digest));

  const refuses = (mutate: (d: Record<string, unknown>) => void, path: RegExp): void => {
    const digest = valid();
    mutate(digest);
    const result = parseStructureDigest(digest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.every((e) => e.code === 'V-L0')).toBe(true);
      expect(result.errors.some((e) => path.test(e.path))).toBe(true);
    }
  };

  it('accepts the reference digest', () => {
    expect(parseStructureDigest(valid()).ok).toBe(true);
  });

  it('C2b-1 A1: refuses an unmarked literal segment, a value-like literal even when marked, and a marked :p/:s', () => {
    const t = (d: Record<string, unknown>) =>
      (d.templates as { template: string; structural: number[] }[])[0];
    refuses((d) => {
      t(d).template = '/v2/coaches/alice-fitness/clients/:p1/members';
      t(d).structural = [0, 1, 3, 5];
    }, /structural/);
    refuses((d) => {
      t(d).template = '/v2/coaches/a8f3k2p9q1/members';
      t(d).structural = [0, 1, 2, 3];
    }, /structural/);
    refuses((d) => {
      t(d).template = '/v2/coaches/48213/members';
      t(d).structural = [0, 1, 2, 3];
    }, /structural/);
    refuses((d) => (t(d).structural = [0, 1, 2, 3]), /structural/);
    refuses((d) => {
      t(d).template = '/v2/:s1/coaches/:p1/members';
      t(d).structural = [0, 1, 2, 4];
    }, /structural/);
  });

  it('constant headers: a structural media type or a session slot is accepted; a tenant marker is refused (L0 r3)', () => {
    const ok = valid();
    ok.constantHeaders = {
      Accept: 'application/vnd.api+json',
      'X-Tenant': ':s1',
      'Accept-Language': 'en-GB,en;q=0.9',
    };
    expect(parseStructureDigest(ok).ok).toBe(true);
    refuses((d) => (d.constantHeaders = { 'X-Tenant': 'acme-fitness' }), /constantHeaders/);
    refuses((d) => (d.constantHeaders = { 'X-Tenant': ':s0' }), /constantHeaders/);
    refuses((d) => (d.constantHeaders = { 'X-Client': 'web-2.14.0' }), /constantHeaders/);
  });

  it('closure markers parse strictly (X2 form): truncated, withheld, explored links, query variants, refusal', () => {
    const d = valid();
    d.truncated = true;
    d.linkTemplates = ['/coach/:p1/programs', '/coach/:p1/clients'];
    d.exploredLinkTemplates = ['/coach/:p1/clients'];
    d.withheld = [{ reason: 'foreign_link', count: 2 }];
    d.originLabelsWithheld = 1;
    d.vocabularyVersion = 1;
    const t0 = (d.templates as Record<string, unknown>[])[0];
    t0.queryVariants = { after: 3 };
    t0.withheldQueryKeys = 1;
    t0.refusal = null;
    const r = parseStructureDigest(d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.truncated).toBe(true);
    expect(unexploredLinkTemplates(r.value)).toEqual(['/coach/:p1/programs']);
    expect(filterVariantKeys(r.value.templates[0])).toEqual(['after']);
    expect(r.value.withheld).toEqual([{ reason: 'foreign_link', count: 2 }]);
    expect(r.value.templates[0].refusal).toBeNull();
    const tpl = (x: Record<string, unknown>): Record<string, unknown> =>
      (x.templates as Record<string, unknown>[])[0];
    refuses((x) => (tpl(x).queryVariants = { status: 2 }), /queryVariants/);
    refuses((x) => (tpl(x).refusal = 'Not A Token'), /refusal/);
    refuses((x) => (x.exploredLinkTemplates = ['/coach/:p1/notes']), /exploredLinkTemplates/);
    refuses((x) => (x.withheld = [{ reason: 'x', count: -1 }]), /withheld/);
    refuses((x) => (x.slotProofs = { t0: ['not-hex'] }), /slotProofs/);
    refuses((x) => (x.linkTemplates = ['/coach/48213991/programs']), /linkTemplates/);
  });
  it('accepts the extension slot channels: :sN and :kN keys, :hN header values, map shapes', () => {
    const d = valid();
    d.constantHeaders = { accept: 'application/json, text/html', role: ':h1' };
    const t0 = (d.templates as Record<string, unknown>[])[0];
    t0.template = '/:s1/coaches/:s2/members';
    delete t0.structural;
    const r = parseStructureDigest(d);
    expect(r.ok).toBe(true);
    refuses((x) => (x.constantHeaders = { role: 'admin-tenant' }), /constantHeaders/);
  });
  it('refuses an extra key', () => refuses((d) => (d.apiBase = '/x'), /apiBase/));
  it('refuses a non-canonical slug', () =>
    refuses((d) => (d.sourcePlatform = 'Bad Slug'), /sourcePlatform/));
  it('refuses an absolute URL template', () =>
    refuses(
      (d) => ((d.templates as Record<string, unknown>[])[0].template = 'https://a.b/x'),
      /template$/,
    ));
  it('refuses a protocol-relative template and a bare id parameter', () => {
    refuses(
      (d) => ((d.templates as Record<string, unknown>[])[0].template = '//a.b/x'),
      /template$/,
    );
    refuses(
      (d) => ((d.templates as Record<string, unknown>[])[0].template = '/v2/coaches/:p2/members'),
      /template$/,
    );
  });
  it('refuses a credential header and a credential-pattern key', () => {
    refuses((d) => (d.constantHeaders = { Authorization: 'x' }), /constantHeaders/);
    refuses((d) => (d.constantHeaders = { Cookie: 'x' }), /constantHeaders/);
    refuses((d) => {
      const shape = (d.templates as Record<string, unknown>[])[0].shape as {
        keys: Record<string, unknown>;
      };
      shape.keys.access_token = { kind: 'string', class: 'text', lengthBucket: '≤32' };
    }, /access_token/);
  });
  it('refuses a header value with a 4-digit run (tenant id)', () =>
    refuses((d) => (d.constantHeaders = { Accept: 'v=12345' }), /constantHeaders/));
  it('refuses a collection path that reaches no array', () =>
    refuses(
      (d) => ((d.templates as Record<string, unknown>[])[0].collectionPaths = [['meta']]),
      /collectionPaths/,
    ));
  it('refuses a shape deeper than 4 and a duplicate ref', () => {
    refuses((d) => {
      const nest = (n: number): unknown =>
        n === 0 ? { kind: 'boolean' } : { kind: 'object', keys: { k: nest(n - 1) } };
      (d.templates as Record<string, unknown>[])[0].shape = nest(6);
      (d.templates as Record<string, unknown>[])[0].collectionPaths = [];
    }, /shape/);
    refuses((d) => {
      const t = d.templates as Record<string, unknown>[];
      t.push({ ...t[0] });
    }, /ref/);
  });
  it('refuses missingFamilies on round 1 and an unknown family', () => {
    refuses((d) => (d.missingFamilies = ['clients']), /missingFamilies/);
    refuses((d) => {
      d.round = 2;
      d.missingFamilies = ['billing'];
    }, /missingFamilies/);
  });
});
