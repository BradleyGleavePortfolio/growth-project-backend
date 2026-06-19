// registry-loader.spec.ts — coverage for the prod-switches.yml registry loader.
// Round-trips the REAL file (so the schema can never drift from the data) and
// drives every schema/validation/helper branch with inline YAML fixtures.

import { join } from 'node:path';
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

  it('accepts an empty switches array', () => {
    expect(() => RegistrySchema.parse({ switches: [] })).not.toThrow();
  });
});

describe('parseRegistry — YAML edge cases', () => {
  it('parses a minimal valid document', () => {
    const reg = parseRegistry(toYaml([row({ name: 'ONE_VAR' })]));
    expect(reg.switches).toHaveLength(1);
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
    const report = validateRegistry(parseRegistry(toYaml([row({ owner: UNOWNED })])));
    const f = report.findings.find((x) => x.kind === 'unowned');
    expect(f?.severity).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('flags MUST_SET + auto_flip as a blocking error', () => {
    const report = validateRegistry(
      parseRegistry(toYaml([row({ prod_default: 'MUST_SET', auto_flip_on_in_prod: true })])),
    );
    const f = report.findings.find((x) => x.kind === 'must-set-but-auto-flip');
    expect(f?.severity).toBe('error');
    expect(report.ok).toBe(false);
  });

  it('does not flag MUST_SET without auto_flip', () => {
    const reg = parseRegistry(
      toYaml([row({ prod_default: 'MUST_SET', auto_flip_on_in_prod: false })]),
    );
    expect(validateRegistry(reg).ok).toBe(true);
  });

  it('flags duplicate names as a blocking error', () => {
    const report = validateRegistry(
      parseRegistry(toYaml([row({ name: 'DUP' }), row({ name: 'DUP' })])),
    );
    expect(report.findings.find((x) => x.kind === 'duplicate-name')?.severity).toBe('error');
    expect(report.ok).toBe(false);
  });

  it('aggregates findings across rows and errorFindings drops warns', () => {
    const report = validateRegistry(
      parseRegistry(
        toYaml([
          row({ name: 'A', owner: UNOWNED }),
          row({ name: 'B', prod_default: 'MUST_SET', auto_flip_on_in_prod: true }),
          row({ name: 'A' }),
        ]),
      ),
    );
    expect(report.findings.length).toBeGreaterThanOrEqual(3);
    expect(report.ok).toBe(false);
    expect(errorFindings(report).every((f) => f.severity === 'error')).toBe(true);
  });
});

describe('helpers', () => {
  const reg: Registry = parseRegistry(
    toYaml([
      row({ name: 'AUTH_A', owner: 'auth' }),
      row({ name: 'AUTH_B', owner: 'auth' }),
      row({ name: 'BILL_A', owner: 'billing' }),
      row({ name: 'ORPHAN', owner: UNOWNED }),
      row({ name: 'MUST_A', prod_default: 'MUST_SET', owner: 'platform' }),
      row({ name: 'FLIP_A', auto_flip_on_in_prod: true, owner: 'jobs' }),
    ]),
  );

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
