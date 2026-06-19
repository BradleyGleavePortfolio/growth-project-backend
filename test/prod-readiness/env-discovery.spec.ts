// env-discovery.spec.ts — coverage for the prod-readiness env-discovery scanner.
//
// Two layers are exercised:
//   1. Discovery (discoverEnvVars / extractEnvVarRefs / extractEnvRuleNames):
//      AST-driven recovery of env-var names from the three sources — ENV_RULES,
//      .env.example, and process.env.* references under src/. Driven mostly with
//      inline content so every access shape (property, element, const-keyed,
//      destructured) and edge (comments, dedup, binary skip) is pinned.
//   2. Registry cross-reference (crossReference / discoverWithRegistry / the
//      findUndeclared / findDead / summary helpers): crosses a discovery against
//      a loaded registry and classifies each name UNDECLARED / DEAD / TRACKED.
//      Fixture src trees + synthetic registries drive the classification matrix;
//      the REAL src/ + REAL prod-switches.yml drive an end-to-end round-trip so
//      the report shape can never drift from the live data.

import { join } from 'node:path';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  discoverEnvVars,
  extractEnvVarRefs,
  extractEnvRuleNames,
  crossReference,
  discoverWithRegistry,
  findUndeclared,
  findDead,
  summary,
  isTestOnly,
  TEST_ONLY_ENV,
  type DiscoveryResult,
  type DiscoveryReport,
  type EnvVarOrigin,
} from './env-discovery';
import { type Registry, type RegistryRow } from './registry-loader';

const REAL_REPO_ROOT = join(__dirname, '..', '..');
const REAL_REGISTRY_PATH = join(REAL_REPO_ROOT, 'prod-switches.yml');

// --- fixture helpers -------------------------------------------------------

/** Make a fresh temp dir for a fixture repo and clean it up after the test. */
const tmpDirs: string[] = [];
async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'env-discovery-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Build one well-formed registry row, overriding fields under test. */
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

/** Build a Registry object directly from names (FS-free, no min-floor). */
function registryOf(names: string[]): Registry {
  return { switches: names.map((name) => row({ name })) };
}

/** Build a DiscoveryResult directly from per-name origin overrides. */
function discoveryOf(entries: Record<string, Partial<EnvVarOrigin>>): DiscoveryResult {
  const envVars = new Map<string, EnvVarOrigin>();
  for (const [name, o] of Object.entries(entries)) {
    envVars.set(name, {
      inEnvRules: false,
      inEnvExample: false,
      inCode: false,
      codeRefs: [],
      ...o,
    });
  }
  return { envVars };
}

/** Write a file inside a fixture repo, creating parent dirs as needed. */
async function writeFixture(repo: string, rel: string, content: string): Promise<void> {
  const abs = join(repo, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

/** Names that survive into a report keyed by status, for terse assertions. */
function namesByStatus(report: DiscoveryReport, status: string): string[] {
  return report.findings
    .filter((f) => f.status === status)
    .map((f) => f.name)
    .sort();
}

// ---------------------------------------------------------------------------
// 1. Discovery — process.env reference extraction (AST)
// ---------------------------------------------------------------------------

describe('extractEnvVarRefs — access shapes', () => {
  it('finds property access process.env.FOO', () => {
    expect([...extractEnvVarRefs('const x = process.env.FOO;')]).toEqual(['FOO']);
  });

  it('finds string element access process.env["BAR"]', () => {
    expect([...extractEnvVarRefs('const x = process.env["BAR"];')]).toEqual(['BAR']);
  });

  it("finds single-quoted element access process.env['BAZ']", () => {
    expect([...extractEnvVarRefs("const x = process.env['BAZ'];")]).toEqual(['BAZ']);
  });

  it('resolves an in-file string const used as the element key', () => {
    const code = "const KEY = 'RESOLVED_VAR'; const x = process.env[KEY];";
    expect([...extractEnvVarRefs(code)]).toEqual(['RESOLVED_VAR']);
  });

  it('does not resolve an identifier key with no string const (skipped)', () => {
    const code = 'function f(k: string) { return process.env[k]; }';
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('finds destructured names const { A_VAR, B_VAR } = process.env', () => {
    const code = 'const { A_VAR, B_VAR } = process.env;';
    expect([...extractEnvVarRefs(code)].sort()).toEqual(['A_VAR', 'B_VAR']);
  });

  it('uses the property name (not alias) for aliased destructuring', () => {
    const code = 'const { ALIASED_VAR: local } = process.env;';
    expect([...extractEnvVarRefs(code)]).toEqual(['ALIASED_VAR']);
  });

  it('dedupes the same var referenced multiple ways in one file', () => {
    const code = 'const a = process.env.DUP; const b = process.env["DUP"];';
    expect([...extractEnvVarRefs(code)]).toEqual(['DUP']);
  });

  it('ignores lowercase / non-UPPER_SNAKE names', () => {
    const code = 'const a = process.env.lower; const b = process.env["1BAD"];';
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('ignores references commented out of the source (AST drops comments)', () => {
    const code = 'const a = process.env.LIVE; // const b = process.env.COMMENTED;';
    expect([...extractEnvVarRefs(code)]).toEqual(['LIVE']);
  });

  it('ignores a process-shaped access that is not process.env', () => {
    const code = 'const a = other.env.NOPE; const b = process.notenv.NOPE2;';
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('returns an empty set for a file with no env references', () => {
    expect([...extractEnvVarRefs('export const x = 1 + 2;')]).toEqual([]);
  });

  it('collects many distinct vars across mixed shapes', () => {
    const code = [
      'const a = process.env.ONE;',
      'const b = process.env["TWO"];',
      'const { THREE } = process.env;',
      "const K = 'FOUR'; const d = process.env[K];",
    ].join('\n');
    expect([...extractEnvVarRefs(code)].sort()).toEqual(['FOUR', 'ONE', 'THREE', 'TWO']);
  });
});

// ---------------------------------------------------------------------------
// 1b. Discovery — ENV_RULES extraction (AST)
// ---------------------------------------------------------------------------

describe('extractEnvRuleNames — ENV_RULES array parsing', () => {
  it('reads name properties off ENV_RULES object literals', async () => {
    const repo = await freshRepo();
    const src = [
      'const ENV_RULES = [',
      "  { name: 'DATABASE_URL', tier: 'hard' },",
      "  { name: 'STRIPE_KEY', tier: 'feature' },",
      '];',
    ].join('\n');
    await writeFixture(repo, 'env-validation.ts', src);
    expect(extractEnvRuleNames(join(repo, 'env-validation.ts')).sort()).toEqual([
      'DATABASE_URL',
      'STRIPE_KEY',
    ]);
  });

  it('is property-order independent (name need not be first)', async () => {
    const repo = await freshRepo();
    const src = "const ENV_RULES = [{ tier: 'hard', name: 'REORDERED' }];";
    await writeFixture(repo, 'env-validation.ts', src);
    expect(extractEnvRuleNames(join(repo, 'env-validation.ts'))).toEqual(['REORDERED']);
  });

  it('parses the TypeScript const-assertion (as const) ENV_RULES shape', async () => {
    const repo = await freshRepo();
    const src = "const ENV_RULES = [{ name: 'AS_CONST_VAR', tier: 'hard' }] as const;";
    await writeFixture(repo, 'env-validation.ts', src);
    expect(extractEnvRuleNames(join(repo, 'env-validation.ts'))).toEqual(['AS_CONST_VAR']);
  });

  it('ignores non-ENV_RULES arrays of objects with a name property', async () => {
    const repo = await freshRepo();
    const src = [
      "const OTHER = [{ name: 'NOT_A_RULE' }];",
      "const ENV_RULES = [{ name: 'REAL_RULE' }];",
    ].join('\n');
    await writeFixture(repo, 'env-validation.ts', src);
    expect(extractEnvRuleNames(join(repo, 'env-validation.ts'))).toEqual(['REAL_RULE']);
  });

  it('extracts the real src/common/env-validation.ts ENV_RULES names', () => {
    const names = extractEnvRuleNames(join(REAL_REPO_ROOT, 'src/common/env-validation.ts'));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});

// ---------------------------------------------------------------------------
// 1c. Discovery — full discoverEnvVars across a fixture repo
// ---------------------------------------------------------------------------

describe('discoverEnvVars — three-source union over a fixture repo', () => {
  it('attributes a var to all three sources when wired end-to-end', async () => {
    const repo = await freshRepo();
    await writeFixture(
      repo,
      'src/common/env-validation.ts',
      "const ENV_RULES = [{ name: 'WIRED' }];",
    );
    await writeFixture(repo, '.env.example', 'WIRED=value');
    await writeFixture(repo, 'src/app.ts', 'const x = process.env.WIRED;');
    const { envVars } = discoverEnvVars(repo);
    const o = envVars.get('WIRED');
    expect(o).toBeDefined();
    expect(o?.inEnvRules).toBe(true);
    expect(o?.inEnvExample).toBe(true);
    expect(o?.inCode).toBe(true);
  });

  it('records code references and counts a var used in many files once', async () => {
    const repo = await freshRepo();
    for (let i = 0; i < 10; i++) {
      await writeFixture(repo, `src/m${i}.ts`, 'const x = process.env.SHARED;');
    }
    const { envVars } = discoverEnvVars(repo);
    const o = envVars.get('SHARED');
    expect(o?.inCode).toBe(true);
    expect(o?.codeRefs.length).toBe(10);
    // The Map keys a var exactly once regardless of reference count.
    expect([...envVars.keys()].filter((k) => k === 'SHARED')).toHaveLength(1);
  });

  it('handles a missing .env.example gracefully (no throw, code-only var)', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'src/app.ts', 'const x = process.env.CODE_ONLY;');
    const { envVars } = discoverEnvVars(repo);
    expect(envVars.get('CODE_ONLY')?.inEnvExample).toBe(false);
    expect(envVars.get('CODE_ONLY')?.inCode).toBe(true);
  });

  it('handles an entirely empty repo (no sources) without throwing', async () => {
    const repo = await freshRepo();
    const { envVars } = discoverEnvVars(repo);
    expect(envVars.size).toBe(0);
  });

  it('parses .env.example lines and ignores comments / blanks', async () => {
    const repo = await freshRepo();
    await writeFixture(
      repo,
      '.env.example',
      ['# a comment', '', 'FROM_EXAMPLE=1', 'lower=skip'].join('\n'),
    );
    const { envVars } = discoverEnvVars(repo);
    expect(envVars.get('FROM_EXAMPLE')?.inEnvExample).toBe(true);
    expect(envVars.has('lower')).toBe(false);
  });

  it('skips binary files under src/ (NUL-byte probe) without throwing', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'src/real.ts', 'const x = process.env.REAL_REF;');
    await writeFile(join(repo, 'src/blob.ts'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const { envVars } = discoverEnvVars(repo);
    expect(envVars.get('REAL_REF')?.inCode).toBe(true);
  });

  it('does not descend into node_modules or dot-directories', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'src/app.ts', 'const x = process.env.KEPT;');
    await writeFixture(repo, 'src/node_modules/dep.ts', 'const y = process.env.IGNORED_DEP;');
    await writeFixture(repo, 'src/.hidden/h.ts', 'const z = process.env.IGNORED_HIDDEN;');
    const { envVars } = discoverEnvVars(repo);
    expect(envVars.has('KEPT')).toBe(true);
    expect(envVars.has('IGNORED_DEP')).toBe(false);
    expect(envVars.has('IGNORED_HIDDEN')).toBe(false);
  });

  it('does not follow a cyclic directory symlink into an infinite loop', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'src/app.ts', 'const x = process.env.CYCLE_VAR;');
    await symlink(join(repo, 'src'), join(repo, 'src/loop'), 'dir').catch(() => {
      // Some sandboxes disallow symlinks; the walk-without-symlink path is still valid.
    });
    const { envVars } = discoverEnvVars(repo);
    expect(envVars.get('CYCLE_VAR')?.inCode).toBe(true);
  });

  it('round-trips the REAL src/ tree into a non-empty discovery', () => {
    const { envVars } = discoverEnvVars(REAL_REPO_ROOT);
    expect(envVars.size).toBeGreaterThan(0);
    for (const name of envVars.keys()) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});

// ---------------------------------------------------------------------------
// 2. Registry cross-reference — classification matrix
// ---------------------------------------------------------------------------

describe('crossReference — UNDECLARED / DEAD / TRACKED classification', () => {
  it('synthetic: 3 code vars, registry has 2 -> 1 UNDECLARED, 0 DEAD, 2 TRACKED', () => {
    const discovery = discoveryOf({
      A: { inCode: true },
      B: { inCode: true },
      C: { inCode: true },
    });
    const registry = registryOf(['A', 'B']);
    const report = crossReference(discovery, registry);
    expect(namesByStatus(report, 'UNDECLARED')).toEqual(['C']);
    expect(namesByStatus(report, 'DEAD')).toEqual([]);
    expect(namesByStatus(report, 'TRACKED')).toEqual(['A', 'B']);
  });

  it('registry has a var absent from code -> reports it DEAD', () => {
    const discovery = discoveryOf({ USED: { inCode: true } });
    const registry = registryOf(['USED', 'STALE_REGISTRY_ONLY']);
    const report = crossReference(discovery, registry);
    expect(namesByStatus(report, 'DEAD')).toEqual(['STALE_REGISTRY_ONLY']);
    expect(namesByStatus(report, 'TRACKED')).toEqual(['USED']);
  });

  it('treats a var present only in .env.example (not code) as referenced', () => {
    const discovery = discoveryOf({ ONBOARDING: { inEnvExample: true } });
    const report = crossReference(discovery, registryOf([]));
    expect(namesByStatus(report, 'UNDECLARED')).toEqual(['ONBOARDING']);
  });

  it('does not classify a var present only in ENV_RULES but never read', () => {
    // inEnvRules alone is not "referenced" (not read by code, not onboarding).
    const discovery = discoveryOf({ RULE_ONLY: { inEnvRules: true } });
    const report = crossReference(discovery, registryOf([]));
    expect(report.findings).toHaveLength(0);
  });

  it('classifies a fully wired var as TRACKED and preserves origin flags', () => {
    const discovery = discoveryOf({
      DB: { inCode: true, inEnvExample: true, inEnvRules: true, codeRefs: ['src/db.ts'] },
    });
    const report = crossReference(discovery, registryOf(['DB']));
    const f = report.findings.find((x) => x.name === 'DB');
    expect(f?.status).toBe('TRACKED');
    expect(f?.inRegistry).toBe(true);
    expect(f?.inEnvRules).toBe(true);
    expect(f?.codeRefs).toEqual(['src/db.ts']);
  });

  it('copies codeRefs defensively (mutating the finding does not touch source)', () => {
    const discovery = discoveryOf({ V: { inCode: true, codeRefs: ['src/a.ts'] } });
    const report = crossReference(discovery, registryOf([]));
    report.findings[0].codeRefs.push('mutated');
    expect(discovery.envVars.get('V')?.codeRefs).toEqual(['src/a.ts']);
  });

  it('excludes _TEST_ prefixed vars from the prod scan (code side)', () => {
    const discovery = discoveryOf({ _TEST_FLAG: { inCode: true }, REAL: { inCode: true } });
    const report = crossReference(discovery, registryOf([]));
    expect(report.findings.map((f) => f.name)).toEqual(['REAL']);
  });

  it('does NOT exclude an INFIXED TEST_ var — it is a real prod var (registry side)', () => {
    // Prefix-anchored exclusion: FEATURE_TEST_MODE does not start with TEST_, so
    // it is a genuine prod switch and (being registry-only / unreferenced) DEAD.
    const discovery = discoveryOf({});
    const registry = registryOf(['FEATURE_TEST_MODE', 'KEEP_VAR']);
    const report = crossReference(discovery, registry);
    expect(namesByStatus(report, 'DEAD')).toEqual(['FEATURE_TEST_MODE', 'KEEP_VAR']);
  });

  it('produces an empty report when discovery and registry are both empty', () => {
    const report = crossReference(discoveryOf({}), registryOf([]));
    expect(report.findings).toEqual([]);
    expect(report.registrySize).toBe(0);
  });

  it('still produces a report (only DEAD) when code discovery is empty', () => {
    const report = crossReference(discoveryOf({}), registryOf(['LONELY']));
    expect(namesByStatus(report, 'DEAD')).toEqual(['LONELY']);
    expect(report.registrySize).toBe(1);
  });

  it('sorts findings by name for stable, diffable reports', () => {
    const discovery = discoveryOf({ ZED: { inCode: true }, ALPHA: { inCode: true } });
    const report = crossReference(discovery, registryOf(['MID']));
    expect(report.findings.map((f) => f.name)).toEqual(['ALPHA', 'MID', 'ZED']);
  });

  it('records registrySize from the registry, independent of classification', () => {
    const registry = registryOf(['A', 'B', 'C', 'D']);
    const report = crossReference(discoveryOf({ A: { inCode: true } }), registry);
    expect(report.registrySize).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 2b. Helpers — findUndeclared / findDead / summary
// ---------------------------------------------------------------------------

describe('report helpers — findUndeclared / findDead / summary', () => {
  const discovery = discoveryOf({
    TRK_A: { inCode: true },
    TRK_B: { inCode: true },
    UND_A: { inCode: true },
  });
  const registry = registryOf(['TRK_A', 'TRK_B', 'DEAD_A', 'DEAD_B']);
  const report = crossReference(discovery, registry);

  it('findUndeclared returns only UNDECLARED findings', () => {
    expect(findUndeclared(report).map((f) => f.name)).toEqual(['UND_A']);
  });

  it('findDead returns only DEAD findings', () => {
    expect(
      findDead(report)
        .map((f) => f.name)
        .sort(),
    ).toEqual(['DEAD_A', 'DEAD_B']);
  });

  it('summary rolls up per-status counts that sum to the total', () => {
    const s = summary(report);
    expect(s).toEqual({ undeclared: 1, dead: 2, tracked: 2, total: 5 });
    expect(s.undeclared + s.dead + s.tracked).toBe(s.total);
  });

  it('summary of an empty report is all zeros', () => {
    expect(summary(crossReference(discoveryOf({}), registryOf([])))).toEqual({
      undeclared: 0,
      dead: 0,
      tracked: 0,
      total: 0,
    });
  });

  it('isTestOnly / TEST_ONLY_ENV agree on test-scaffold names (prefix-anchored)', () => {
    expect(isTestOnly('_TEST_X')).toBe(true);
    // INFIXED TEST_ is a real prod var, not test-only, under the prefix anchor.
    expect(isTestOnly('FEATURE_TEST_MODE')).toBe(false);
    expect(isTestOnly('DATABASE_URL')).toBe(false);
    expect(TEST_ONLY_ENV.test('_TEST_X')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2c. discoverWithRegistry — end-to-end (fixtures + real data)
// ---------------------------------------------------------------------------

describe('discoverWithRegistry — end-to-end scan', () => {
  /** Build a registry YAML with enough padded rows to satisfy the min floor. */
  function registryYaml(names: string[]): string {
    const all = [...names];
    for (let i = all.length; i < 205; i++) all.push(`FILLER_${i}`);
    const body = all
      .map(
        (n) =>
          `  - name: ${n}\n    tier: optional\n    prod_default: STUB_ALLOWED\n` +
          `    auto_flip_on_in_prod: false\n    owner: platform\n    description: "x"\n`,
      )
      .join('');
    return `switches:\n${body}`;
  }

  it('crosses a fixture src tree against a fixture registry file on disk', async () => {
    const repo = await freshRepo();
    await writeFixture(
      repo,
      'src/app.ts',
      'const a = process.env.TRACKED_ONE; const b = process.env.UNDECLARED_ONE;',
    );
    await writeFixture(repo, 'prod-switches.yml', registryYaml(['TRACKED_ONE', 'DEAD_ONE']));
    const report = await discoverWithRegistry(repo, join(repo, 'prod-switches.yml'));
    expect(namesByStatus(report, 'TRACKED')).toContain('TRACKED_ONE');
    expect(namesByStatus(report, 'UNDECLARED')).toContain('UNDECLARED_ONE');
    expect(namesByStatus(report, 'DEAD')).toContain('DEAD_ONE');
  });

  it('re-throws a missing-registry error wrapped with discovery context', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'src/app.ts', 'const a = process.env.X;');
    await expect(discoverWithRegistry(repo, join(repo, 'does-not-exist.yml'))).rejects.toThrow(
      /env-discovery could not load registry/,
    );
  });

  it('re-throws an invalid-registry (too-few-rows) error with context', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'src/app.ts', 'const a = process.env.X;');
    await writeFixture(
      repo,
      'prod-switches.yml',
      'switches:\n  - name: ONLY_ONE\n    tier: optional\n    prod_default: OFF\n    auto_flip_on_in_prod: false\n    owner: platform\n    description: "x"\n',
    );
    await expect(discoverWithRegistry(repo, join(repo, 'prod-switches.yml'))).rejects.toThrow(
      /env-discovery could not load registry/,
    );
  });

  it('round-trips the REAL src/ against the REAL prod-switches.yml', async () => {
    const report = await discoverWithRegistry(REAL_REPO_ROOT, REAL_REGISTRY_PATH);
    expect(report.registrySize).toBeGreaterThan(200);
    expect(report.findings.length).toBeGreaterThan(0);
    const s = summary(report);
    expect(s.total).toBe(report.findings.length);
    // Every finding carries a valid env-var name and a known status.
    for (const f of report.findings) {
      expect(f.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(['UNDECLARED', 'DEAD', 'TRACKED']).toContain(f.status);
    }
  });

  it('defaults the registry path to <repoRoot>/prod-switches.yml', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'src/app.ts', 'const a = process.env.DEFAULTED;');
    await writeFixture(repo, 'prod-switches.yml', registryYaml(['DEFAULTED']));
    const report = await discoverWithRegistry(repo);
    expect(namesByStatus(report, 'TRACKED')).toContain('DEFAULTED');
  });
});

// ---------------------------------------------------------------------------
// 3. Discovery — deeper AST coverage (nested scopes, template/numeric keys)
// ---------------------------------------------------------------------------

describe('extractEnvVarRefs — nested and unusual positions', () => {
  it('finds a reference nested inside a function body', () => {
    const code = 'function load() { return { url: process.env.NESTED_URL }; }';
    expect([...extractEnvVarRefs(code)]).toEqual(['NESTED_URL']);
  });

  it('finds a reference inside an arrow inside an object property', () => {
    const code = 'const cfg = { get: () => process.env.LAZY_VAR };';
    expect([...extractEnvVarRefs(code)]).toEqual(['LAZY_VAR']);
  });

  it('finds a reference inside a ternary expression', () => {
    const code = 'const x = cond ? process.env.YES_VAR : process.env.NO_VAR;';
    expect([...extractEnvVarRefs(code)].sort()).toEqual(['NO_VAR', 'YES_VAR']);
  });

  it('finds references across multiple statements in one file', () => {
    const code = [
      'export function a() { return process.env.STMT_A; }',
      'export function b() { return process.env.STMT_B; }',
    ].join('\n');
    expect([...extractEnvVarRefs(code)].sort()).toEqual(['STMT_A', 'STMT_B']);
  });

  it('ignores a numeric element-access key (not a valid env name)', () => {
    const code = 'const x = process.env[0];';
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('ignores a template-literal element-access key (not statically a name)', () => {
    const code = 'const x = process.env[`PREFIX_${dyn}`];';
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('resolves a const declared after its use in the same file', () => {
    // collectStringConsts scans the whole file, so declaration order is moot.
    const code = 'const v = process.env[LATE]; const LATE = "LATE_VAR";';
    expect([...extractEnvVarRefs(code)]).toEqual(['LATE_VAR']);
  });

  it('does not treat a non-string const key as a name', () => {
    const code = 'const NUM = 42; const v = process.env[NUM];';
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('accepts UPPER_SNAKE names containing digits and underscores', () => {
    const code = 'const x = process.env.OAUTH2_CLIENT_ID;';
    expect([...extractEnvVarRefs(code)]).toEqual(['OAUTH2_CLIENT_ID']);
  });

  it('rejects a leading-digit candidate via element access', () => {
    const code = 'const x = process.env["2FA_SECRET"];';
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3b. extractEnvRuleNames — empty / malformed inputs
// ---------------------------------------------------------------------------

describe('extractEnvRuleNames — empty and malformed ENV_RULES', () => {
  it('returns no names when ENV_RULES is an empty array', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'env-validation.ts', 'const ENV_RULES = [];');
    expect(extractEnvRuleNames(join(repo, 'env-validation.ts'))).toEqual([]);
  });

  it('returns no names when the file has no ENV_RULES at all', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'env-validation.ts', 'export const SOMETHING = 1;');
    expect(extractEnvRuleNames(join(repo, 'env-validation.ts'))).toEqual([]);
  });

  it('skips object entries whose name value is not UPPER_SNAKE', async () => {
    const repo = await freshRepo();
    const src = "const ENV_RULES = [{ name: 'lowercase' }, { name: 'GOOD_NAME' }];";
    await writeFixture(repo, 'env-validation.ts', src);
    expect(extractEnvRuleNames(join(repo, 'env-validation.ts'))).toEqual(['GOOD_NAME']);
  });

  it('dedupes a name that appears twice in ENV_RULES', async () => {
    const repo = await freshRepo();
    const src = "const ENV_RULES = [{ name: 'DUPE' }, { name: 'DUPE' }];";
    await writeFixture(repo, 'env-validation.ts', src);
    expect(extractEnvRuleNames(join(repo, 'env-validation.ts'))).toEqual(['DUPE']);
  });
});

// ---------------------------------------------------------------------------
// 3c. discoverEnvVars — source attribution combinations
// ---------------------------------------------------------------------------

describe('discoverEnvVars — partial source attribution', () => {
  it('attributes a var to ENV_RULES + .env.example but not code', async () => {
    const repo = await freshRepo();
    await writeFixture(
      repo,
      'src/common/env-validation.ts',
      "const ENV_RULES = [{ name: 'NO_CODE' }];",
    );
    await writeFixture(repo, '.env.example', 'NO_CODE=1');
    const { envVars } = discoverEnvVars(repo);
    const o = envVars.get('NO_CODE');
    expect(o?.inEnvRules).toBe(true);
    expect(o?.inEnvExample).toBe(true);
    expect(o?.inCode).toBe(false);
  });

  it('attributes a var to code only when neither rules nor example list it', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'src/svc.ts', 'const x = process.env.CODE_SOLE;');
    const o = discoverEnvVars(repo).envVars.get('CODE_SOLE');
    expect(o).toEqual({
      inEnvRules: false,
      inEnvExample: false,
      inCode: true,
      codeRefs: ['src/svc.ts'],
    });
  });

  it('uses repo-root-relative paths for code references', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'src/deep/nested/file.ts', 'const x = process.env.DEEP_VAR;');
    const o = discoverEnvVars(repo).envVars.get('DEEP_VAR');
    expect(o?.codeRefs).toEqual(['src/deep/nested/file.ts']);
  });

  it('collects multiple distinct vars from a single source file', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'src/multi.ts', 'const a = process.env.MA; const b = process.env.MB;');
    const keys = [...discoverEnvVars(repo).envVars.keys()].sort();
    expect(keys).toEqual(['MA', 'MB']);
  });

  it('tolerates an .env.example with CRLF line endings', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, '.env.example', 'WIN_VAR=1\r\nOTHER_VAR=2\r\n');
    const keys = [...discoverEnvVars(repo).envVars.keys()].sort();
    expect(keys).toEqual(['OTHER_VAR', 'WIN_VAR']);
  });

  it('ignores a src directory that is actually absent', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, '.env.example', 'ONLY_EXAMPLE=1');
    // no src/ dir created
    const { envVars } = discoverEnvVars(repo);
    expect([...envVars.keys()]).toEqual(['ONLY_EXAMPLE']);
  });
});

// ---------------------------------------------------------------------------
// 3d. crossReference / helpers — additional matrix corners
// ---------------------------------------------------------------------------

describe('crossReference — additional corners', () => {
  it('classifies a var read in code AND present in registry as TRACKED even if also in rules+example', () => {
    const discovery = discoveryOf({
      FULL: { inCode: true, inEnvExample: true, inEnvRules: true },
    });
    const report = crossReference(discovery, registryOf(['FULL']));
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].status).toBe('TRACKED');
  });

  it('marks a registry var that exists in discovery only via ENV_RULES as DEAD', () => {
    // inEnvRules alone is not "referenced", and the name IS in discovery, so it
    // is neither TRACKED (not referenced) nor DEAD (it IS discovered): dropped.
    const discovery = discoveryOf({ RULE_REG: { inEnvRules: true } });
    const report = crossReference(discovery, registryOf(['RULE_REG']));
    expect(report.findings).toHaveLength(0);
  });

  it('handles a large mix of undeclared, dead, and tracked vars', () => {
    const discovery = discoveryOf({
      T1: { inCode: true },
      T2: { inCode: true },
      T3: { inEnvExample: true },
      U1: { inCode: true },
      U2: { inEnvExample: true },
    });
    const registry = registryOf(['T1', 'T2', 'T3', 'D1', 'D2', 'D3']);
    const s = summary(crossReference(discovery, registry));
    expect(s).toEqual({ undeclared: 2, dead: 3, tracked: 3, total: 8 });
  });

  it('excludes test-only names from BOTH undeclared and dead buckets at once', () => {
    const discovery = discoveryOf({ _TEST_A: { inCode: true }, REAL_U: { inCode: true } });
    const registry = registryOf(['_TEST_B', 'REAL_D']);
    const report = crossReference(discovery, registry);
    expect(namesByStatus(report, 'UNDECLARED')).toEqual(['REAL_U']);
    expect(namesByStatus(report, 'DEAD')).toEqual(['REAL_D']);
    expect(report.findings.some((f) => f.name.includes('_TEST_'))).toBe(false);
  });

  it('findUndeclared / findDead return empty arrays for an all-tracked report', () => {
    const discovery = discoveryOf({ ONLY: { inCode: true } });
    const report = crossReference(discovery, registryOf(['ONLY']));
    expect(findUndeclared(report)).toEqual([]);
    expect(findDead(report)).toEqual([]);
    expect(summary(report).tracked).toBe(1);
  });

  it('DEAD findings carry empty codeRefs and inCode false', () => {
    const report = crossReference(discoveryOf({}), registryOf(['DEADER']));
    const f = report.findings[0];
    expect(f.codeRefs).toEqual([]);
    expect(f.inCode).toBe(false);
    expect(f.inRegistry).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3e. discoverWithRegistry — more end-to-end paths
// ---------------------------------------------------------------------------

describe('discoverWithRegistry — additional end-to-end paths', () => {
  function regYaml(names: string[]): string {
    const all = [...names];
    for (let i = all.length; i < 205; i++) all.push(`FILLER_${i}`);
    return (
      'switches:\n' +
      all
        .map(
          (n) =>
            `  - name: ${n}\n    tier: optional\n    prod_default: STUB_ALLOWED\n` +
            `    auto_flip_on_in_prod: false\n    owner: platform\n    description: "x"\n`,
        )
        .join('')
    );
  }

  it('reports a clean (all-TRACKED) repo with zero undeclared and zero dead', async () => {
    const repo = await freshRepo();
    await writeFixture(
      repo,
      'src/a.ts',
      'const x = process.env.CLEAN_A; const y = process.env.CLEAN_B;',
    );
    await writeFixture(repo, 'prod-switches.yml', regYaml(['CLEAN_A', 'CLEAN_B']));
    const report = await discoverWithRegistry(repo, join(repo, 'prod-switches.yml'));
    const s = summary(report);
    expect(findUndeclared(report)).toEqual([]);
    // FILLER_* rows are DEAD (not referenced in code), so dead > 0 is expected.
    expect(s.tracked).toBeGreaterThanOrEqual(2);
  });

  it('re-throws when the registry YAML uses a banned anchor (parse error wrapped)', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'src/a.ts', 'const x = process.env.X;');
    await writeFixture(repo, 'prod-switches.yml', 'switches: &anchor []\n');
    await expect(discoverWithRegistry(repo, join(repo, 'prod-switches.yml'))).rejects.toThrow(
      /env-discovery could not load registry/,
    );
  });

  it('includes the offending registry path in the wrapped error message', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'src/a.ts', 'const x = process.env.X;');
    const missing = join(repo, 'nope.yml');
    await expect(discoverWithRegistry(repo, missing)).rejects.toThrow(missing);
  });

  it('counts FILLER rows toward registrySize in the end-to-end report', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'src/a.ts', 'const x = process.env.TRACKED_X;');
    await writeFixture(repo, 'prod-switches.yml', regYaml(['TRACKED_X']));
    const report = await discoverWithRegistry(repo, join(repo, 'prod-switches.yml'));
    expect(report.registrySize).toBeGreaterThanOrEqual(205);
  });
});

// ---------------------------------------------------------------------------
// 4. Discovery — robustness corners that pin documented behaviour
// ---------------------------------------------------------------------------

describe('extractEnvVarRefs — destructuring and rest corners', () => {
  it('captures every name in a multi-name destructuring', () => {
    const code = 'const { D_ONE, D_TWO, D_THREE } = process.env;';
    expect([...extractEnvVarRefs(code)].sort()).toEqual(['D_ONE', 'D_THREE', 'D_TWO']);
  });

  it('captures the property name even when a default is supplied', () => {
    const code = "const { DEF_VAR = 'fallback' } = process.env;";
    expect([...extractEnvVarRefs(code)]).toEqual(['DEF_VAR']);
  });

  it('does not capture a rest element as an env name', () => {
    const code = 'const { KNOWN_VAR, ...rest } = process.env;';
    expect([...extractEnvVarRefs(code)]).toEqual(['KNOWN_VAR']);
  });

  it('captures references appearing in both a destructuring and a property access', () => {
    const code = 'const { FIRST } = process.env; const s = process.env.SECOND;';
    expect([...extractEnvVarRefs(code)].sort()).toEqual(['FIRST', 'SECOND']);
  });

  it('handles a file that only assigns to process.env (still no false names)', () => {
    const code = "process.env.WRITTEN = 'x';";
    // An assignment target is still a property access read by the AST walker.
    expect([...extractEnvVarRefs(code)]).toEqual(['WRITTEN']);
  });

  it('treats two different files independently (no cross-file const leakage)', () => {
    const a = extractEnvVarRefs("const K = 'A_VAR'; const x = process.env[K];", 'a.ts');
    const b = extractEnvVarRefs('const y = process.env[K];', 'b.ts');
    expect([...a]).toEqual(['A_VAR']);
    // K is undefined in b.ts, so the identifier key resolves to nothing.
    expect([...b]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F001 — computed destructuring keys: `const { ["FOO"]: x } = process.env` and
// `const K = 'FOO'; const { [K]: x } = process.env`. The plain-identifier
// destructuring path only saw IdentifierName keys; a ComputedPropertyName must
// be unwrapped and resolved the same way bracket-access keys are.
// ---------------------------------------------------------------------------

describe('extractEnvVarRefs — computed destructuring keys (F001)', () => {
  it('resolves a string-literal computed key { ["FOO"]: x }', () => {
    const code = 'const { ["COMPUTED_LIT"]: x } = process.env;';
    expect([...extractEnvVarRefs(code)]).toEqual(['COMPUTED_LIT']);
  });

  it('resolves a single-quoted string-literal computed key', () => {
    const code = "const { ['COMPUTED_SQ']: x } = process.env;";
    expect([...extractEnvVarRefs(code)]).toEqual(['COMPUTED_SQ']);
  });

  it('resolves a no-substitution template-literal computed key', () => {
    const code = 'const { [`COMPUTED_TPL`]: x } = process.env;';
    expect([...extractEnvVarRefs(code)]).toEqual(['COMPUTED_TPL']);
  });

  it('resolves a const-backed computed key { [K]: x }', () => {
    const code = "const K = 'CONST_KEYED'; const { [K]: x } = process.env;";
    expect([...extractEnvVarRefs(code)]).toEqual(['CONST_KEYED']);
  });

  it('resolves a const-backed computed key through an `as const` wrapper', () => {
    const code = "const K = 'WRAPPED_KEY' as const; const { [K]: x } = process.env;";
    expect([...extractEnvVarRefs(code)]).toEqual(['WRAPPED_KEY']);
  });

  it('does NOT record a let-aliased computed key (mutable alias)', () => {
    const code = "let K = 'MUTABLE_KEY'; const { [K]: x } = process.env;";
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('skips a computed key whose identifier has no in-file string const', () => {
    const code = 'const { [unknownKey]: x } = process.env;';
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('skips a substitution template-literal computed key (not static)', () => {
    const code = 'const { [`PREFIX_${dyn}`]: x } = process.env;';
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('rejects a non-UPPER_SNAKE string-literal computed key', () => {
    const code = 'const { ["lowerKey"]: x } = process.env;';
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('mixes a plain and a computed destructuring key in one pattern', () => {
    const code = 'const { PLAIN_KEY, ["COMPUTED_MIX"]: x } = process.env;';
    expect([...extractEnvVarRefs(code)].sort()).toEqual(['COMPUTED_MIX', 'PLAIN_KEY']);
  });
});

// ---------------------------------------------------------------------------
// F002 — file-wide const map shadowing: collectStringConsts keys by identifier
// name with no scope tracking, so a name bound more than once cannot be soundly
// resolved. Per the conservative "ambiguous binding → skip" (option B) policy a
// name resolves ONLY when it is bound exactly once in the file.
// ---------------------------------------------------------------------------

describe('extractEnvVarRefs — ambiguous const-key shadowing (F002)', () => {
  it('drops a name re-declared at file scope twice (fail closed)', () => {
    const code = [
      "const K = 'OUTER_VAL';",
      'const a = process.env[K];',
      "const K2 = 'X'; const K = 'INNER_VAL';",
    ].join('\n');
    // K is bound twice → unresolvable → neither OUTER_VAL nor INNER_VAL.
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('drops a name shadowed by an inner block const (fail closed)', () => {
    const code = [
      "const K = 'FOO';",
      'const a = process.env[K];',
      "{ const K = 'BAR'; void K; }",
    ].join('\n');
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('drops a name shadowed inside a function scope (fail closed)', () => {
    const code = [
      "const K = 'FOO';",
      'const a = process.env[K];',
      "function f() { const K = 'BAR'; return K; }",
    ].join('\n');
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('drops a const shadowed by a let of the same name (mutable alias)', () => {
    const code = [
      "const K = 'FOO';",
      'const a = process.env[K];',
      "{ let K = 'BAR'; K = 'BAZ'; void K; }",
    ].join('\n');
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('still resolves a name bound exactly once even with other distinct consts', () => {
    const code = [
      "const ONLY = 'SINGLE_VAR';",
      "const OTHER = 'unused';",
      'const a = process.env[ONLY];',
    ].join('\n');
    expect([...extractEnvVarRefs(code)]).toEqual(['SINGLE_VAR']);
  });

  it('drops an ambiguous name but keeps a distinct single-bound name', () => {
    const code = [
      "const DUPE = 'FIRST';",
      "const KEEP = 'KEEP_VAR';",
      'const a = process.env[DUPE];',
      'const b = process.env[KEEP];',
      "function f() { const DUPE = 'SECOND'; return DUPE; }",
    ].join('\n');
    // DUPE bound twice → dropped; KEEP bound once → resolved.
    expect([...extractEnvVarRefs(code)]).toEqual(['KEEP_VAR']);
  });

  it('drops an ambiguous name used as a computed destructuring key (F001+F002)', () => {
    const code = [
      "const K = 'FOO';",
      'const { [K]: x } = process.env;',
      "{ const K = 'BAR'; void K; }",
    ].join('\n');
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });
});

describe('discoverEnvVars — mixed-source repo end-to-end shape', () => {
  it('produces a union whose every entry has the full origin shape', async () => {
    const repo = await freshRepo();
    await writeFixture(
      repo,
      'src/common/env-validation.ts',
      "const ENV_RULES = [{ name: 'R_VAR' }];",
    );
    await writeFixture(repo, '.env.example', 'E_VAR=1');
    await writeFixture(repo, 'src/use.ts', 'const x = process.env.C_VAR;');
    const { envVars } = discoverEnvVars(repo);
    expect([...envVars.keys()].sort()).toEqual(['C_VAR', 'E_VAR', 'R_VAR']);
    for (const o of envVars.values()) {
      expect(typeof o.inEnvRules).toBe('boolean');
      expect(typeof o.inEnvExample).toBe('boolean');
      expect(typeof o.inCode).toBe('boolean');
      expect(Array.isArray(o.codeRefs)).toBe(true);
    }
  });

  it('records the same var from two files in both codeRefs entries', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'src/one.ts', 'const x = process.env.TWICE;');
    await writeFixture(repo, 'src/two.ts', 'const y = process.env.TWICE;');
    const o = discoverEnvVars(repo).envVars.get('TWICE');
    expect(o?.codeRefs.sort()).toEqual(['src/one.ts', 'src/two.ts']);
  });

  it('does not double-count a var referenced twice within one file', async () => {
    const repo = await freshRepo();
    await writeFixture(
      repo,
      'src/dup.ts',
      'const a = process.env.ONCE; const b = process.env.ONCE;',
    );
    const o = discoverEnvVars(repo).envVars.get('ONCE');
    expect(o?.codeRefs).toEqual(['src/dup.ts']);
  });
});

describe('summary / helpers — invariants on real-data report', () => {
  it('summary buckets of the REAL report each match the per-status filters', async () => {
    const report = await discoverWithRegistry(REAL_REPO_ROOT, REAL_REGISTRY_PATH);
    const s = summary(report);
    expect(findUndeclared(report)).toHaveLength(s.undeclared);
    expect(findDead(report)).toHaveLength(s.dead);
    expect(s.tracked).toBe(s.total - s.undeclared - s.dead);
  });

  it('every REAL finding has a consistent inRegistry flag for its status', async () => {
    const report = await discoverWithRegistry(REAL_REPO_ROOT, REAL_REGISTRY_PATH);
    for (const f of report.findings) {
      if (f.status === 'TRACKED') expect(f.inRegistry).toBe(true);
      if (f.status === 'DEAD') expect(f.inRegistry).toBe(true);
      if (f.status === 'UNDECLARED') expect(f.inRegistry).toBe(false);
    }
  });

  it('no REAL finding is a test-only name (the prod scan excludes them)', async () => {
    const report = await discoverWithRegistry(REAL_REPO_ROOT, REAL_REGISTRY_PATH);
    for (const f of report.findings) expect(isTestOnly(f.name)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Lens B regression probes (H4.B R1)
// ---------------------------------------------------------------------------

// Finding 1 (MAJOR): the test-only exclusion must be PREFIX-anchored so that
// genuine prod vars containing an infixed `TEST_` segment are not silently
// hidden from the readiness scan. `isTestOnly` is true only for names that
// START with an optional underscore then `TEST_`.
describe('isTestOnly — prefix-anchored TEST_ exclusion (Finding 1)', () => {
  it('EXCLUDES TEST_ONLY (bare prefix)', () => {
    expect(isTestOnly('TEST_ONLY')).toBe(true);
  });

  it('EXCLUDES _TEST_FLAG (underscore + prefix)', () => {
    expect(isTestOnly('_TEST_FLAG')).toBe(true);
  });

  it('INCLUDES MY_TEST_VAR (infixed TEST_ — real prod var)', () => {
    expect(isTestOnly('MY_TEST_VAR')).toBe(false);
  });

  it('INCLUDES AB_TEST_BUCKET (infixed TEST_ — real prod var)', () => {
    expect(isTestOnly('AB_TEST_BUCKET')).toBe(false);
  });

  it('INCLUDES FEATURE_TEST_MODE (infixed TEST_ — real prod var)', () => {
    expect(isTestOnly('FEATURE_TEST_MODE')).toBe(false);
  });

  it('INCLUDES TESTING_ENABLED (TEST not followed by underscore)', () => {
    // The anchor requires `TEST_`; `TESTING_` does not match, so this is prod.
    expect(isTestOnly('TESTING_ENABLED')).toBe(false);
  });

  it('the regex itself agrees with isTestOnly on the same set', () => {
    expect(TEST_ONLY_ENV.test('TEST_ONLY')).toBe(true);
    expect(TEST_ONLY_ENV.test('_TEST_FLAG')).toBe(true);
    expect(TEST_ONLY_ENV.test('MY_TEST_VAR')).toBe(false);
    expect(TEST_ONLY_ENV.test('AB_TEST_BUCKET')).toBe(false);
  });

  it('an infixed-TEST_ var read in code now surfaces as UNDECLARED (not hidden)', () => {
    const discovery = discoveryOf({ MY_TEST_VAR: { inCode: true } });
    const report = crossReference(discovery, registryOf([]));
    expect(namesByStatus(report, 'UNDECLARED')).toEqual(['MY_TEST_VAR']);
  });
});

// Finding 2 (MAJOR): bracket access to the env namespace — `process['env'].X`
// and `process['env']['Y']` — must be discovered exactly like `process.env.X`.
describe('extractEnvVarRefs — process["env"] bracket access (Finding 2)', () => {
  it('discovers process["env"].HIDDEN (double-quoted env, property key)', () => {
    expect([...extractEnvVarRefs('const x = process["env"].HIDDEN;')]).toEqual(['HIDDEN']);
  });

  it("discovers process['env'].HIDDEN (single-quoted env, property key)", () => {
    expect([...extractEnvVarRefs("const x = process['env'].HIDDEN;")]).toEqual(['HIDDEN']);
  });

  it('discovers process["env"]["HIDDEN2"] (double-quoted env, string key)', () => {
    expect([...extractEnvVarRefs('const x = process["env"]["HIDDEN2"];')]).toEqual(['HIDDEN2']);
  });

  it("discovers process['env']['HIDDEN2'] (single-quoted env, string key)", () => {
    expect([...extractEnvVarRefs("const x = process['env']['HIDDEN2'];")]).toEqual(['HIDDEN2']);
  });

  it('resolves an in-file const key under bracket-env access', () => {
    const code = "const K = 'BRACKET_CONST'; const x = process['env'][K];";
    expect([...extractEnvVarRefs(code)]).toEqual(['BRACKET_CONST']);
  });

  it('discovers a destructuring off bracket-env: const { D_VAR } = process["env"]', () => {
    expect([...extractEnvVarRefs('const { D_VAR } = process["env"];')]).toEqual(['D_VAR']);
  });

  it('does NOT treat process["notenv"].X as an env reference', () => {
    expect([...extractEnvVarRefs('const x = process["notenv"].X;')]).toEqual([]);
  });

  it('does NOT treat other["env"].X (non-process base) as an env reference', () => {
    expect([...extractEnvVarRefs('const x = other["env"].X;')]).toEqual([]);
  });

  it('collects mixed dot-env and bracket-env references in one file', () => {
    const code = [
      'const a = process.env.DOT_VAR;',
      'const b = process["env"].BRACKET_VAR;',
      'const c = process["env"]["BRACKET_STR"];',
    ].join('\n');
    expect([...extractEnvVarRefs(code)].sort()).toEqual(['BRACKET_STR', 'BRACKET_VAR', 'DOT_VAR']);
  });

  it('surfaces a bracket-env var end-to-end via discoverEnvVars', async () => {
    const repo = await freshRepo();
    await writeFixture(repo, 'src/svc.ts', "const h = process['env'].END_TO_END_HIDDEN;");
    const o = discoverEnvVars(repo).envVars.get('END_TO_END_HIDDEN');
    expect(o?.inCode).toBe(true);
    expect(o?.codeRefs).toEqual(['src/svc.ts']);
  });
});

// Finding 3 (MINOR): import.meta.env (Vite/frontend) is intentionally out of
// scope for this NestJS backend. The scanner must return [] for it — this test
// documents the deliberate scope boundary so a future reader does not mistake
// the omission for a bug.
describe('extractEnvVarRefs — import.meta.env is out of scope (Finding 3)', () => {
  it('returns [] for import.meta.env.VITE_FLAG (no Vite in this repo)', () => {
    expect([...extractEnvVarRefs('const x = import.meta.env.VITE_FLAG;')]).toEqual([]);
  });

  it('returns [] for bracket import.meta.env["VITE_OTHER"]', () => {
    expect([...extractEnvVarRefs('const x = import.meta.env["VITE_OTHER"];')]).toEqual([]);
  });

  it('ignores import.meta.env but still finds a sibling process.env ref', () => {
    const code = 'const a = import.meta.env.VITE_X; const b = process.env.NODE_REAL;';
    expect([...extractEnvVarRefs(code)]).toEqual(['NODE_REAL']);
  });
});

describe('collectStringConsts via extractEnvVarRefs — const-only alias keys (R2 F001)', () => {
  it('resolves a const string key: const K = "FOO"; process.env[K] -> FOO', () => {
    const code = 'const K = "FOO"; const v = process.env[K];';
    expect([...extractEnvVarRefs(code)]).toEqual(['FOO']);
  });

  it('does NOT resolve a let alias key: let K = "FOO"; process.env[K] -> []', () => {
    const code = 'let K = "FOO"; const v = process.env[K];';
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('does NOT resolve a var alias key: var K = "FOO"; process.env[K] -> []', () => {
    const code = 'var K = "FOO"; const v = process.env[K];';
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('does NOT resolve a let alias even when never reassigned (mutable by type)', () => {
    const code = 'let MUT = "MUTABLE_NAME";\nconst v = process.env[MUT];';
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });

  it('resolves only the const key when a const and a let share the env-key role', () => {
    const code =
      'const GOOD = "GOOD_VAR"; let BAD = "BAD_VAR";\n' +
      'const a = process.env[GOOD]; const b = process.env[BAD];';
    expect([...extractEnvVarRefs(code)]).toEqual(['GOOD_VAR']);
  });
});

describe('extractEnvVarRefs — expression-wrapper unwrapping (R2 F002)', () => {
  it('discovers (process)["env"].FOO (parenthesized process, string env, property key)', () => {
    expect([...extractEnvVarRefs('const v = (process)["env"].FOO;')]).toEqual(['FOO']);
  });

  it('discovers (process).env.FOO (parenthesized process, dot env)', () => {
    expect([...extractEnvVarRefs('const v = (process).env.FOO;')]).toEqual(['FOO']);
  });

  it('discovers (process.env).FOO (parenthesized process.env)', () => {
    expect([...extractEnvVarRefs('const v = (process.env).FOO;')]).toEqual(['FOO']);
  });

  it('discovers const { FOO } = (process.env) (parenthesized destructuring init)', () => {
    expect([...extractEnvVarRefs('const { FOO } = (process.env);')]).toEqual(['FOO']);
  });

  it('discovers process.env!.FOO (non-null assertion on the namespace)', () => {
    expect([...extractEnvVarRefs('const v = process.env!.FOO;')]).toEqual(['FOO']);
  });

  it('discovers (process.env as Record<string,string>).FOO (as-cast on the namespace)', () => {
    const code = 'const v = (process.env as Record<string, string>).FOO;';
    expect([...extractEnvVarRefs(code)]).toEqual(['FOO']);
  });

  it('discovers (process.env satisfies Record<string,string>).FOO (satisfies on the namespace)', () => {
    const code = 'const v = (process.env satisfies Record<string, string>).FOO;';
    expect([...extractEnvVarRefs(code)]).toEqual(['FOO']);
  });

  it('unwraps wrappers for string-element keys too: (process.env as Record<...>)["BAR"]', () => {
    const code = 'const v = (process.env as Record<string, string>)["BAR"];';
    expect([...extractEnvVarRefs(code)]).toEqual(['BAR']);
  });

  it('still rejects a wrapped NON-process namespace: (other.env).FOO -> []', () => {
    expect([...extractEnvVarRefs('const v = (other.env).FOO;')]).toEqual([]);
  });

  it('still rejects (process.notenv).FOO -> [] (wrapper does not invent env)', () => {
    expect([...extractEnvVarRefs('const v = (process.notenv).FOO;')]).toEqual([]);
  });

  it('collects several wrapper shapes in one file without duplicates', () => {
    const code =
      'const a = (process.env).A_ONE;\n' +
      'const b = process.env!.B_TWO;\n' +
      'const c = (process.env as Record<string, string>).C_THREE;\n' +
      'const { D_FOUR } = (process.env);';
    expect([...extractEnvVarRefs(code)].sort()).toEqual(['A_ONE', 'B_TWO', 'C_THREE', 'D_FOUR']);
  });
});

describe('extractEnvVarRefs — literal-preserving const initializers (R2 F003)', () => {
  it('discovers const K = "FOO" as const; process.env[K] -> FOO', () => {
    const code = 'const K = "FOO" as const; const v = process.env[K];';
    expect([...extractEnvVarRefs(code)]).toEqual(['FOO']);
  });

  it('discovers a plain as-cast key: const K = "FOO" as string; process.env[K] -> FOO', () => {
    const code = 'const K = "FOO" as string; const v = process.env[K];';
    expect([...extractEnvVarRefs(code)]).toEqual(['FOO']);
  });

  it('discovers a satisfies key: const K = "FOO" satisfies string; process.env[K] -> FOO', () => {
    const code = 'const K = "FOO" satisfies string; const v = process.env[K];';
    expect([...extractEnvVarRefs(code)]).toEqual(['FOO']);
  });

  it('discovers a parenthesized key: const K = ("FOO"); process.env[K] -> FOO', () => {
    const code = 'const K = ("FOO"); const v = process.env[K];';
    expect([...extractEnvVarRefs(code)]).toEqual(['FOO']);
  });

  it('discovers a no-substitution-template key: const K = `FOO`; process.env[K] -> FOO', () => {
    const code = 'const K = `FOO`; const v = process.env[K];';
    expect([...extractEnvVarRefs(code)]).toEqual(['FOO']);
  });

  it('discovers a nested-wrapper key: const K = ("FOO" as const); process.env[K] -> FOO', () => {
    const code = 'const K = ("FOO" as const); const v = process.env[K];';
    expect([...extractEnvVarRefs(code)]).toEqual(['FOO']);
  });

  it('keeps the F001 rejection under as const: let K = "FOO" as const; process.env[K] -> []', () => {
    const code = 'let K = "FOO" as const; const v = process.env[K];';
    expect([...extractEnvVarRefs(code)]).toEqual([]);
  });
});
