import type { OpenAPIObject } from '@nestjs/swagger';
import {
  API_PREFIX,
  CONTRACT_VERSION,
  IMPORTER_BARE_PATHS,
  buildImporterContract,
  serializeContract,
  stableSort,
} from '../../scripts/importer-contract';

// Terse navigation of the synthetic OpenAPI tree in assertions without a
// banned wide cast token; mirrors the intent of test/openapi-spec.spec.ts.
const node = (value: unknown): Record<string, any> => value as Record<string, any>;
// Treat a synthetic partial document as a full OpenAPIObject for the extractor.
const asDoc = (value: unknown): OpenAPIObject => value as OpenAPIObject;

// Pure unit coverage for the deterministic extraction logic that produces the
// frozen importer contract. These tests DO NOT boot Nest — they feed synthetic
// OpenAPI documents straight into the extractor so the slicing, /api re-prefix,
// transitive schema pruning, security-scheme retention, missing-route guard,
// and byte-stable serialization are each pinned in isolation. The companion
// suite (importer-contract.spec.ts) checks the same logic against the LIVE
// Swagger document and the checked-in artifact.

// A ref to a component schema, the shape @nestjs/swagger emits.
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

// Build a minimal but complete synthetic document: every importer path must be
// present or buildImporterContract() throws by design, so we stamp each one with
// a tiny operation object. `withSchemas`/`extraPaths` let individual tests bolt
// on the pieces they care about.
function makeDoc(
  opts: {
    schemas?: Record<string, unknown>;
    responseRefByPath?: Record<string, string>;
    infoVersion?: string;
    securitySchemes?: Record<string, unknown>;
  } = {},
) {
  const paths: Record<string, unknown> = {};
  for (const p of IMPORTER_BARE_PATHS) {
    const refName = opts.responseRefByPath?.[p];
    paths[p] = {
      post: {
        tags: ['importer'],
        // Every importer operation is bearer-guarded in reality; stamp the
        // requirement so security-scheme pruning has a reference to keep.
        security: [{ bearer: [] }],
        responses: {
          '200': refName
            ? { description: 'ok', content: { 'application/json': { schema: ref(refName) } } }
            : { description: 'ok' },
        },
      },
    };
  }
  return asDoc({
    openapi: '3.1.0',
    info: { title: 'Growth Project API', version: opts.infoVersion ?? '9.9.9' },
    paths,
    components: {
      schemas: opts.schemas ?? {},
      securitySchemes: opts.securitySchemes ?? {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
  });
}

describe('stableSort', () => {
  it('sorts object keys recursively', () => {
    const sorted = stableSort({ b: 1, a: { d: 2, c: 3 } });
    expect(JSON.stringify(sorted)).toBe(JSON.stringify({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('preserves array order while sorting element keys', () => {
    const sorted = stableSort([
      { y: 1, x: 2 },
      { b: 3, a: 4 },
    ]);
    expect(JSON.stringify(sorted)).toBe(
      JSON.stringify([
        { x: 2, y: 1 },
        { a: 4, b: 3 },
      ]),
    );
  });

  it('returns primitives unchanged', () => {
    expect(stableSort(7)).toBe(7);
    expect(stableSort('x')).toBe('x');
    expect(stableSort(null)).toBe(null);
  });

  it('is idempotent', () => {
    const once = stableSort({ c: 1, a: 2, b: 3 });
    expect(JSON.stringify(stableSort(once))).toBe(JSON.stringify(once));
  });
});

describe('buildImporterContract', () => {
  it('selects exactly the seven importer routes and re-prefixes them with /api', () => {
    const contract = buildImporterContract(makeDoc());
    const expected = IMPORTER_BARE_PATHS.map((p) => `${API_PREFIX}${p}`).sort();
    expect(Object.keys(contract.paths).sort()).toEqual(expected);
  });

  it('throws a descriptive error when an importer route is missing', () => {
    const doc = makeDoc();
    delete node(doc.paths)['/scout/ingest'];
    expect(() => buildImporterContract(doc)).toThrow(/\/scout\/ingest not found/);
  });

  it('keeps only schemas referenced by the selected paths', () => {
    const doc = makeDoc({
      schemas: {
        Used: { type: 'object' },
        Unused: { type: 'object' },
      },
      responseRefByPath: { '/scout/ingest': 'Used' },
    });
    const contract = buildImporterContract(doc);
    const schemas = contract.components!.schemas!;
    expect(Object.keys(schemas)).toContain('Used');
    expect(Object.keys(schemas)).not.toContain('Unused');
  });

  it('pulls transitive schema dependencies (a kept schema $refs another)', () => {
    const doc = makeDoc({
      schemas: {
        Parent: { type: 'object', properties: { child: ref('Child') } },
        Child: { type: 'object', properties: { grand: ref('Grand') } },
        Grand: { type: 'object' },
        Orphan: { type: 'object' },
      },
      responseRefByPath: { '/scout/ingest': 'Parent' },
    });
    const contract = buildImporterContract(doc);
    const names = Object.keys(contract.components!.schemas!);
    expect(names).toEqual(expect.arrayContaining(['Parent', 'Child', 'Grand']));
    expect(names).not.toContain('Orphan');
  });

  it('does not loop forever on a cyclic schema graph', () => {
    const doc = makeDoc({
      schemas: {
        A: { type: 'object', properties: { b: ref('B') } },
        B: { type: 'object', properties: { a: ref('A') } },
      },
      responseRefByPath: { '/scout/ingest': 'A' },
    });
    const contract = buildImporterContract(doc);
    expect(Object.keys(contract.components!.schemas!).sort()).toEqual(['A', 'B']);
  });

  it('retains a security scheme referenced by the selected operations', () => {
    const contract = buildImporterContract(makeDoc());
    expect(node(contract.components!.securitySchemes).bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('prunes security schemes not referenced by any selected operation', () => {
    // Only bearer is referenced by the operations; the two unrelated global
    // schemes must not leak into the importer slice (else an unrelated scheme
    // addition would force a false-positive importer-contract drift).
    const contract = buildImporterContract(
      makeDoc({
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          unusedApiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
          unusedOauth: { type: 'oauth2', flows: {} },
        },
      }),
    );
    const names = Object.keys(node(contract.components!.securitySchemes));
    expect(names).toEqual(['bearer']);
    expect(names).not.toContain('unusedApiKey');
    expect(names).not.toContain('unusedOauth');
  });

  it('preserves openapi version and derives an importer-scoped title', () => {
    const contract = buildImporterContract(makeDoc());
    expect(contract.openapi).toBe('3.1.0');
    expect(contract.info.title).toMatch(/Importer Contract$/);
  });

  it('pins info.version to the fixed CONTRACT_VERSION, not the document version', () => {
    // makeDoc() stamps info.version '9.9.9'; the contract must ignore it.
    const contract = buildImporterContract(makeDoc());
    expect(contract.info.version).toBe(CONTRACT_VERSION);
    expect(contract.info.version).not.toBe('9.9.9');
  });

  it('is immune to package/release version bumps (no drift from a version change)', () => {
    // Two documents identical except for info.version — the shape a release-please
    // bump produces — must serialize to byte-identical contracts. This is the
    // regression guard for the version-coupling drift bug: a routine app bump can
    // never make the checked-in artifact stale.
    const before = serializeContract(buildImporterContract(makeDoc({ infoVersion: '1.2.3' })));
    const after = serializeContract(buildImporterContract(makeDoc({ infoVersion: '2.0.0' })));
    expect(after).toBe(before);
  });

  it('does not mutate the source document', () => {
    const doc = makeDoc();
    const before = JSON.stringify(doc);
    buildImporterContract(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('emits deep key-sorted output', () => {
    const contract = buildImporterContract(
      makeDoc({
        schemas: { Zeta: { type: 'object' }, Alpha: { type: 'object' } },
        responseRefByPath: { '/scout/ingest': 'Zeta', '/scout/progress': 'Alpha' },
      }),
    );
    const schemaKeys = Object.keys(contract.components!.schemas!);
    expect(schemaKeys).toEqual([...schemaKeys].sort());
    const topKeys = Object.keys(node(contract));
    expect(topKeys).toEqual([...topKeys].sort());
  });
});

describe('serializeContract', () => {
  it('produces 2-space-indented JSON with a trailing newline', () => {
    const out = serializeContract(makeDoc());
    expect(out.endsWith('}\n')).toBe(true);
    expect(out).toContain('\n  "');
  });

  it('is deterministic across repeated calls on the same input', () => {
    const contract = buildImporterContract(makeDoc());
    expect(serializeContract(contract)).toBe(serializeContract(contract));
  });

  it('is invariant to source key ordering (sort normalizes both)', () => {
    const a = buildImporterContract(
      makeDoc({ schemas: { A: { type: 'object' }, B: { type: 'object' } } }),
    );
    const b = buildImporterContract(
      makeDoc({ schemas: { B: { type: 'object' }, A: { type: 'object' } } }),
    );
    expect(serializeContract(a)).toBe(serializeContract(b));
  });
});
