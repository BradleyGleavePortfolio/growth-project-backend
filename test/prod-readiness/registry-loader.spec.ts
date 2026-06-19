// registry-loader.spec.ts — coverage for the prod-switches.yml registry loader.
// Round-trips the REAL file (so the schema can never drift from the data) and
// drives every schema/validation/helper branch with inline YAML fixtures.

import { join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  loadRegistry,
  parseRegistry,
  validateRegistry,
  errorFindings,
  getByOwner,
  getProdRequired,
  getUnowned,
  getAutoFlip,
  listOwners,
  RegistryRowSchema,
  RegistrySchema,
  RegistryParseError,
  MIN_SWITCHES,
  TIERS,
  PROD_DEFAULTS,
  UNOWNED,
  type Registry,
  type RegistryRow,
} from './registry-loader';

const REAL_REGISTRY_PATH = join(__dirname, '..', '..', 'prod-switches.yml');

/** Build a single well-formed row, overriding any fields under test. */
function row(overrides: Partial<RegistryRow> = {}): RegistryRow {
  return {
    name: 'SOME_VAR',
    tier: 'optional',
    prod_default: 'STUB_ALLOWED',
    auto_flip_on_in_prod: false,
    owner: 'platform',
    description: 'a switch used somewhere in the codebase',
    ...overrides,
  };
}

/** Serialize rows into a minimal `switches:` YAML document. */
function toYaml(rows: RegistryRow[]): string {
  const body = rows
    .map(
      (r) =>
        `  - name: ${r.name}\n    tier: ${r.tier}\n    prod_default: ${r.prod_default}\n` +
        `    auto_flip_on_in_prod: ${r.auto_flip_on_in_prod}\n    owner: ${r.owner}\n` +
        `    description: ${JSON.stringify(r.description)}\n`,
    )
    .join('');
  return `switches:\n${body}`;
}

/**
 * Pad a list of rows up to `MIN_SWITCHES` with unique, benign filler rows so
 * the `.min(MIN_SWITCHES)` floor is satisfied. Filler names are namespaced
 * (`FILLER_*`) and owned/typed so they raise no coherence findings, letting
 * the rows-under-test drive every assertion. The caller's rows come first so
 * positional lookups (e.g. `reg.switches[0]`) remain stable.
 */
function pad(rows: RegistryRow[]): RegistryRow[] {
  const filler: RegistryRow[] = [];
  for (let i = rows.length; i < MIN_SWITCHES; i++) {
    filler.push(row({ name: `FILLER_${i}`, owner: 'platform' }));
  }
  return [...rows, ...filler];
}

/** Build a padded registry from the rows under test (satisfies the min floor). */
function parseRows(rows: RegistryRow[]): Registry {
  return parseRegistry(toYaml(pad(rows)));
}

describe('loadRegistry — real prod-switches.yml', () => {
  let real: Registry;
  beforeAll(async () => {
    real = await loadRegistry(REAL_REGISTRY_PATH);
  });

  it('round-trips the real file into a >200-row switches array', () => {
    expect(Array.isArray(real.switches)).toBe(true);
    expect(real.switches.length).toBeGreaterThan(200);
  });

  it('every row satisfies the per-field invariants', () => {
    for (const r of real.switches) {
      expect(r.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(TIERS).toContain(r.tier);
      expect(PROD_DEFAULTS).toContain(r.prod_default);
      expect(typeof r.auto_flip_on_in_prod).toBe('boolean');
      expect(r.description.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate names', () => {
    const names = real.switches.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('contains the canonical DATABASE_URL hard/MUST_SET row', () => {
    const db = real.switches.find((r) => r.name === 'DATABASE_URL');
    expect(db?.tier).toBe('hard');
    expect(db?.prod_default).toBe('MUST_SET');
  });

  it('reports no error-severity findings on the real file', () => {
    expect(errorFindings(validateRegistry(real))).toHaveLength(0);
  });

  it('getProdRequired returns only MUST_SET rows, none auto-flipped', () => {
    const req = getProdRequired(real);
    expect(req.length).toBeGreaterThan(0);
    for (const r of req) {
      expect(r.prod_default).toBe('MUST_SET');
      expect(r.auto_flip_on_in_prod).toBe(false);
    }
  });

  it('getUnowned / getAutoFlip return correctly-filtered subsets', () => {
    for (const r of getUnowned(real)) expect(r.owner).toBe(UNOWNED);
    for (const r of getAutoFlip(real)) expect(r.auto_flip_on_in_prod).toBe(true);
  });

  it('owner partitions are sorted, distinct, and sum to the full count', () => {
    const owners = listOwners(real);
    expect([...owners]).toEqual([...owners].sort());
    expect(owners).toContain('platform');
    const total = owners.reduce((acc, o) => acc + getByOwner(real, o).length, 0);
    expect(total).toBe(real.switches.length);
  });
});

describe('schema validation', () => {
  it('accepts a fully well-formed row', () => {
    expect(() => RegistryRowSchema.parse(row())).not.toThrow();
  });

  it('rejects a row missing owner', () => {
    const bad = { ...row() } as Record<string, unknown>;
    delete bad.owner;
    expect(() => RegistryRowSchema.parse(bad)).toThrow();
  });

  it('rejects a row missing name', () => {
    const bad = { ...row() } as Record<string, unknown>;
    delete bad.name;
    expect(() => RegistryRowSchema.parse(bad)).toThrow();
  });

  it('rejects an empty name', () => {
    expect(() => RegistryRowSchema.parse(row({ name: '' }))).toThrow();
  });

  it('rejects a lowercase env name', () => {
    expect(() => RegistryRowSchema.parse(row({ name: 'lower_case' }))).toThrow();
  });

  it('rejects a name starting with a digit', () => {
    expect(() => RegistryRowSchema.parse(row({ name: '1ABC' }))).toThrow();
  });

  it('rejects unknown enum values and a non-boolean auto_flip', () => {
    expect(() => RegistryRowSchema.parse({ ...row(), tier: 'bogus' } as unknown)).toThrow();
    expect(() => RegistryRowSchema.parse({ ...row(), prod_default: 'MAYBE' } as unknown)).toThrow();
    expect(() =>
      RegistryRowSchema.parse({ ...row(), auto_flip_on_in_prod: 'true' } as unknown),
    ).toThrow();
  });

  it('rejects unknown extra fields (strict schema)', () => {
    expect(() => RegistryRowSchema.parse({ ...row(), surprise: 1 } as unknown)).toThrow();
  });

  it('rejects a top-level object without switches and a non-array switches', () => {
    expect(() => RegistrySchema.parse({})).toThrow();
    expect(() => RegistrySchema.parse({ switches: 'nope' })).toThrow();
  });

  it('rejects an empty switches array (truncation guardrail, MIN_SWITCHES)', () => {
    expect(() => RegistrySchema.parse({ switches: [] })).toThrow(/guardrail bypass/i);
  });

  it('rejects a single-row switches array as truncated', () => {
    expect(() => RegistrySchema.parse({ switches: [row()] })).toThrow(/guardrail bypass/i);
  });

  it(`rejects a switches array just under the ${MIN_SWITCHES}-row floor`, () => {
    const justUnder = Array.from({ length: MIN_SWITCHES - 1 }, (_unused, i) =>
      row({ name: `UNDER_${i}` }),
    );
    expect(() => RegistrySchema.parse({ switches: justUnder })).toThrow(/guardrail bypass/i);
  });

  it(`accepts a switches array at the ${MIN_SWITCHES}-row floor`, () => {
    const atFloor = Array.from({ length: MIN_SWITCHES }, (_unused, i) => row({ name: `AT_${i}` }));
    expect(() => RegistrySchema.parse({ switches: atFloor })).not.toThrow();
  });
});

describe('parseRegistry — YAML edge cases', () => {
  it('parses a minimal valid document', () => {
    const reg = parseRows([row({ name: 'ONE_VAR' })]);
    expect(reg.switches.length).toBeGreaterThanOrEqual(MIN_SWITCHES);
    expect(reg.switches[0].name).toBe('ONE_VAR');
  });

  it('throws on empty and whitespace-only documents', () => {
    expect(() => parseRegistry('')).toThrow(/empty/i);
    expect(() => parseRegistry('   \n  \n')).toThrow(/empty/i);
  });

  it('throws on malformed YAML and on a bare scalar', () => {
    expect(() => parseRegistry('switches: [oops')).toThrow();
    expect(() => parseRegistry('just-a-string')).toThrow();
  });

  it('throws when a row fails schema validation after YAML parse', () => {
    expect(() => parseRegistry('switches:\n  - name: ok_lower\n    tier: optional\n')).toThrow();
  });
});

describe('validateRegistry — coherence findings', () => {
  it('flags an unowned row as a non-blocking warn', () => {
    const report = validateRegistry(parseRows([row({ owner: UNOWNED })]));
    const f = report.findings.find((x) => x.kind === 'unowned');
    expect(f?.severity).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('flags MUST_SET + auto_flip as a blocking error', () => {
    const report = validateRegistry(
      parseRows([row({ prod_default: 'MUST_SET', auto_flip_on_in_prod: true })]),
    );
    const f = report.findings.find((x) => x.kind === 'must-set-but-auto-flip');
    expect(f?.severity).toBe('error');
    expect(report.ok).toBe(false);
  });

  it('does not flag MUST_SET without auto_flip', () => {
    const reg = parseRows([row({ prod_default: 'MUST_SET', auto_flip_on_in_prod: false })]);
    expect(validateRegistry(reg).ok).toBe(true);
  });

  it('flags duplicate names as a blocking error', () => {
    const report = validateRegistry(
      parseRows([row({ name: 'DUP' }), row({ name: 'DUP' })]),
    );
    expect(report.findings.find((x) => x.kind === 'duplicate-name')?.severity).toBe('error');
    expect(report.ok).toBe(false);
  });

  it('aggregates findings across rows and errorFindings drops warns', () => {
    const report = validateRegistry(
      parseRows([
        row({ name: 'A', owner: UNOWNED }),
        row({ name: 'B', prod_default: 'MUST_SET', auto_flip_on_in_prod: true }),
        row({ name: 'A' }),
      ]),
    );
    expect(report.findings.length).toBeGreaterThanOrEqual(3);
    expect(report.ok).toBe(false);
    expect(errorFindings(report).every((f) => f.severity === 'error')).toBe(true);
  });
});

describe('helpers', () => {
  const reg: Registry = parseRows([
    row({ name: 'AUTH_A', owner: 'auth' }),
    row({ name: 'AUTH_B', owner: 'auth' }),
    row({ name: 'BILL_A', owner: 'billing' }),
    row({ name: 'ORPHAN', owner: UNOWNED }),
    row({ name: 'MUST_A', prod_default: 'MUST_SET', owner: 'platform' }),
    row({ name: 'FLIP_A', auto_flip_on_in_prod: true, owner: 'jobs' }),
  ]);

  it('getByOwner returns only matching rows, empty for unknown owner', () => {
    expect(getByOwner(reg, 'auth').map((r) => r.name).sort()).toEqual(['AUTH_A', 'AUTH_B']);
    expect(getByOwner(reg, 'nobody')).toHaveLength(0);
  });

  it('getProdRequired / getUnowned / getAutoFlip return correct subsets', () => {
    expect(getProdRequired(reg).map((r) => r.name)).toEqual(['MUST_A']);
    expect(getUnowned(reg).map((r) => r.name)).toEqual(['ORPHAN']);
    expect(getAutoFlip(reg).map((r) => r.name)).toEqual(['FLIP_A']);
  });

  it('listOwners returns sorted distinct owners', () => {
    expect(listOwners(reg)).toEqual(['auth', 'billing', 'jobs', 'platform', UNOWNED]);
  });

  it('helpers are pure (do not mutate the registry)', () => {
    const before = reg.switches.length;
    getByOwner(reg, 'auth');
    getProdRequired(reg);
    getUnowned(reg);
    getAutoFlip(reg);
    expect(reg.switches.length).toBe(before);
  });
});

describe('loadRegistry — error messages cite the source filename (F1)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'registry-loader-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Write `contents` to a uniquely-named file under the temp dir and return its path. */
  async function tmpFile(basename: string, contents: string): Promise<string> {
    const p = join(dir, basename);
    await writeFile(p, contents, 'utf8');
    return p;
  }

  it('attaches the filename and the offending field path with expected/received types', async () => {
    // Padded to satisfy the min-rows floor; the FIRST row has a non-boolean
    // auto_flip_on_in_prod so the failure is a per-field type error, not the floor.
    const rows = pad([row({ name: 'BAD_BOOL' })]);
    let doc = toYaml(rows);
    doc = doc.replace('    auto_flip_on_in_prod: false\n', '    auto_flip_on_in_prod: notabool\n');
    const path = await tmpFile('bad-bool.yml', doc);
    await expect(loadRegistry(path)).rejects.toThrow(RegistryParseError);
    const err = await loadRegistry(path).catch((e: unknown) => e);
    const message = (err as Error).message;
    expect(message).toContain(path); // filename
    expect(message).toContain('switches.0.auto_flip_on_in_prod'); // offending field path
    expect(message).toMatch(/expected boolean/i); // expected type
    expect(message).toMatch(/received string/i); // received type
  });

  it('attaches the filename when a required field is missing', async () => {
    const rows = pad([row({ name: 'NO_OWNER' })]);
    let doc = toYaml(rows);
    doc = doc.replace('    owner: platform\n    description', '    description');
    const path = await tmpFile('no-owner.yml', doc);
    const err = await loadRegistry(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryParseError);
    const message = (err as Error).message;
    expect(message).toContain(path);
    expect(message).toContain('owner');
  });

  it('attaches the filename to the truncated-registry (floor) failure', async () => {
    const path = await tmpFile('truncated.yml', toYaml([row({ name: 'ONLY_ONE' })]));
    const err = await loadRegistry(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryParseError);
    const message = (err as Error).message;
    expect(message).toContain(path);
    expect(message).toMatch(/guardrail bypass/i);
  });

  it('attaches the filename to the empty-registry failure', async () => {
    const path = await tmpFile('empty.yml', '   \n');
    const err = await loadRegistry(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistryParseError);
    expect((err as Error).message).toContain(path);
    expect((err as Error).message).toMatch(/empty/i);
  });
});

describe('parseRegistry — rejects YAML anchors/aliases/merge keys (MINOR-1)', () => {
  it('rejects a merge key (<<:) with an actionable, line-numbered error', () => {
    const doc =
      'defaults: &base\n  tier: optional\n  prod_default: STUB_ALLOWED\n' +
      'switches:\n  - name: MERGED_VAR\n    <<: *base\n' +
      '    auto_flip_on_in_prod: false\n    owner: platform\n    description: "x"\n';
    expect(() => parseRegistry(doc)).toThrow(RegistryParseError);
    expect(() => parseRegistry(doc)).toThrow(/merge key/i);
    expect(() => parseRegistry(doc)).toThrow(/self-contained for diff-reviewability/i);
  });

  it('rejects an anchor definition (&name)', () => {
    const doc =
      'switches:\n  - &first\n    name: ANCHORED_VAR\n    tier: optional\n' +
      '    prod_default: STUB_ALLOWED\n    auto_flip_on_in_prod: false\n' +
      '    owner: platform\n    description: "x"\n';
    expect(() => parseRegistry(doc)).toThrow(RegistryParseError);
    expect(() => parseRegistry(doc)).toThrow(/anchors\/aliases/i);
  });

  it('rejects an alias reference (*name)', () => {
    const doc =
      'first: &a SOME_TEXT\nswitches:\n  - name: ALIASED_VAR\n    tier: optional\n' +
      '    prod_default: STUB_ALLOWED\n    auto_flip_on_in_prod: false\n' +
      '    owner: *a\n    description: "x"\n';
    expect(() => parseRegistry(doc)).toThrow(RegistryParseError);
    expect(() => parseRegistry(doc)).toThrow(/anchors\/aliases/i);
  });

  it('does not false-positive on & or * inside quoted strings or descriptions', () => {
    const reg = parseRows([
      row({ name: 'AMP_DESC', description: 'tom & jerry uses a * wildcard' }),
    ]);
    expect(reg.switches[0].description).toContain('&');
    expect(reg.switches[0].description).toContain('*');
  });

  it('does not false-positive on & or * inside a # comment', () => {
    const rows = pad([row({ name: 'COMMENTED' })]);
    const doc = `# defaults &base and *alias mentioned only in prose\n${toYaml(rows)}`;
    expect(() => parseRegistry(doc)).not.toThrow();
  });

  it('reports the FIRST anchor/alias line when several are present', () => {
    const doc =
      'a: 1\nb: &two 2\nc: &three 3\nswitches:\n  - name: X\n    tier: optional\n' +
      '    prod_default: STUB_ALLOWED\n    auto_flip_on_in_prod: false\n' +
      '    owner: platform\n    description: "x"\n';
    expect(() => parseRegistry(doc)).toThrow(/line 2\b/);
  });

  it('prefers the merge-key message even when an anchor appears earlier', () => {
    const doc =
      'base: &b { tier: optional }\nswitches:\n  - name: Y\n    <<: *b\n' +
      '    prod_default: STUB_ALLOWED\n    auto_flip_on_in_prod: false\n' +
      '    owner: platform\n    name2: x\n    description: "x"\n';
    expect(() => parseRegistry(doc)).toThrow(/merge key/i);
  });

  it('the real prod-switches.yml is free of anchors/aliases/merge keys', async () => {
    // loadRegistry runs assertNoYamlIndirection on the real file; a clean load
    // proves the seeded registry is fully self-contained for diff review.
    await expect(loadRegistry(REAL_REGISTRY_PATH)).resolves.toBeDefined();
  });
});

describe('loadRegistry — happy path through the filesystem', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'registry-loader-ok-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads, parses, and validates a well-formed file at or above the floor', async () => {
    const rows = pad([row({ name: 'FIRST_VAR', owner: 'platform' })]);
    const path = join(dir, 'good.yml');
    await writeFile(path, toYaml(rows), 'utf8');
    const reg = await loadRegistry(path);
    expect(reg.switches.length).toBeGreaterThanOrEqual(MIN_SWITCHES);
    expect(reg.switches[0].name).toBe('FIRST_VAR');
    expect(validateRegistry(reg).ok).toBe(true);
  });

  it('tolerates CRLF line endings on an otherwise valid file', async () => {
    const rows = pad([row({ name: 'CRLF_VAR' })]);
    const path = join(dir, 'crlf.yml');
    await writeFile(path, toYaml(rows).replace(/\n/g, '\r\n'), 'utf8');
    const reg = await loadRegistry(path);
    expect(reg.switches[0].name).toBe('CRLF_VAR');
  });
});
