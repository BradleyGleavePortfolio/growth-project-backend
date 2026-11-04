// Executable regression tests for the R75 / R100.A2 banned-token gate.
//
// These run the repository checker (scripts/check-r75.js) as a real child process
// against real temporary Git repositories and a real index. Nothing here
// re-implements the gate: a test reasoning about its own copy of the algorithm
// would pass while the shipped gate stayed broken, which is how the pre-repair
// gate survived.
//
// Every banned literal used as input lives in fixtures/r75-cases.json, because
// .json is not an executable extension in .github/r75-policy.json. Test files
// the production build leaves out are outside the scan (owner ruling #192-D6
// op 1), but this suite still keeps every banned literal in fixture data.
//
// Each repaired defect also carries a negative control: the deleted pre-repair
// shell algorithm is reproduced from fixture data and asserted to DISAGREE with
// the checker on the defect it repaired, so a silent regression to the old
// semantics fails the suite.

import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..');
const CHECKER = join(REPO_ROOT, 'scripts', 'check-r75.js');
const POLICY_IN_REPO = '.github/r75-policy.json';
const POLICY = join(REPO_ROOT, POLICY_IN_REPO);
const BUILD_TSCONFIG = join(REPO_ROOT, 'tsconfig.build.json');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'r100-quality-gate.yml');
const HOOKS = join(REPO_ROOT, 'lefthook.yml');

interface FileMap {
  [path: string]: string[];
}

interface GateCase {
  name: string;
  mode: 'range' | 'staged';
  base?: FileMap;
  head?: FileMap;
  staged?: FileMap;
  unstaged?: FileMap;
  renameTo?: { [from: string]: string };
  deletePaths?: string[];
  weakenWorkingTreePolicy?: boolean;
  expectExit: number;
  expectNet?: { [token: string]: number };
  expectOffenders?: string[];
  expectEvidenceFiles?: string[];
  // Paths whose added casts must not appear in the checker's evidence at all.
  expectAbsentFiles?: string[];
  legacyExit?: number;
  control?: 'verdict' | 'undercount';
  controlToken?: string;
  why: string;
}

interface OperationalCase {
  name: string;
  args: string[];
  expectExit: number;
  // A policy body to stage at the real in-repo path. There is no filesystem
  // override flag, so an unusable policy is exercised through the production
  // path: staged bytes at .github/r75-policy.json.
  stagePolicy?: string;
  // The fail-closed reason, when the case proves one specific validation.
  expectStderr?: string;
}

interface LegacyPolicy {
  literalTokens: string[];
  emptyCatchLiterals: string[];
  emptyCatchPattern: string;
  exemptLinePattern: string;
  excludeSuffixes: string[];
  includeRoots: string[];
}

const FIXTURES = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'r75-cases.json'), 'utf8'),
) as {
  policyExpectations: { suppressionToken: string; emptyCatchClasses: string[] };
  legacyAlgorithm: LegacyPolicy;
  cases: GateCase[];
  operationalCases: OperationalCase[];
};

const REAL_POLICY = readFileSync(POLICY, 'utf8');
// A policy that parses and validates but detects nothing the cases care about.
// Used only to prove the checker does not read it when the index carries the
// real one.
const WEAK_POLICY = JSON.stringify({
  scan: { ...JSON.parse(REAL_POLICY).scan, includeRoots: ['nowhere/'] },
  tokens: [{ name: 'zzz-not-a-real-token', pattern: 'zzz-not-a-real-token' }],
});

const tempRoots: string[] = [];
const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

function newRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'r75-gate-'));
  tempRoots.push(repo);
  git(repo, ['init', '-q', '.']);
  git(repo, ['config', 'user.email', 'test@invalid.local']);
  git(repo, ['config', 'user.name', 'test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  return repo;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: GIT_ENV,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    killSignal: 'SIGKILL',
  }).trim();
}

function writeFiles(repo: string, files: FileMap): void {
  for (const [rel, lines] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${lines.join('\n')}\n`);
  }
}

// The checker reads its policy from the Git content it is measuring, so every
// temporary repo carries the real committed policy at the real path.
function installPolicy(repo: string, body: string): void {
  const abs = join(repo, POLICY_IN_REPO);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

interface CheckerResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runChecker(repo: string, args: string[]): CheckerResult {
  const res = spawnSync(process.execPath, [CHECKER, ...args], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    env: GIT_ENV,
    killSignal: 'SIGKILL',
  });
  if (res.error || res.signal || res.status === null) {
    throw res.error ?? new Error(`harness process interrupted: ${res.signal}`);
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Before/after totals may include unchanged matches; only their net is the delta.
function reportedNet(stdout: string, token: string): number | undefined {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(token)) continue;
    const m = /\+(\d+)\s+-(\d+)\s+net\s+([+-]?\d+)/.exec(trimmed);
    if (m) return parseInt(m[3], 10);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Negative control: the deleted pre-repair shell algorithm, reproduced from
// fixture data — aggregate cross-token netting, grep -c line counting,
// whole-line suppression stripping, and spec/test exclusion.
// ---------------------------------------------------------------------------

interface LegacyResult {
  exit: number;
  perToken: { [token: string]: number };
}

function legacyScan(repo: string, range: string | null, legacy: LegacyPolicy): LegacyResult {
  const args = ['diff', '--unified=0', '--no-color'];
  const diff = range === null ? git(repo, [...args, '--cached']) : git(repo, [...args, range]);

  let currentNew: string | null = null;
  let currentOld: string | null = null;
  const added: string[] = [];
  const removed: string[] = [];
  const inLegacyScope = (p: string | null): boolean => {
    if (!p) return false;
    if (legacy.excludeSuffixes.some((s) => p.endsWith(s))) return false;
    return legacy.includeRoots.some((r) => p.startsWith(r));
  };
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('--- ')) {
      const p = raw.slice(4);
      currentOld = p === '/dev/null' ? null : p.replace(/^[ab]\//, '');
    } else if (raw.startsWith('+++ ')) {
      const p = raw.slice(4);
      currentNew = p === '/dev/null' ? null : p.replace(/^[ab]\//, '');
    } else if (raw.startsWith('+') && !raw.startsWith('+++') && inLegacyScope(currentNew)) {
      added.push(raw.slice(1));
    } else if (raw.startsWith('-') && !raw.startsWith('---') && inLegacyScope(currentOld)) {
      removed.push(raw.slice(1));
    }
  }

  // Defect: the whole line is discarded when it carries a documented suppression.
  const exempt = new RegExp(legacy.exemptLinePattern);
  const keep = (lines: string[]): string[] => lines.filter((l) => !exempt.test(l));
  const addedScan = keep(added);
  const removedScan = keep(removed);

  // Defect: grep -c counts matching LINES, never occurrences.
  const lineCount = (lines: string[], needle: string): number =>
    lines.filter((l) => l.includes(needle)).length;
  const reCount = (lines: string[], pattern: string): number => {
    const re = new RegExp(pattern);
    return lines.filter((l) => re.test(l)).length;
  };

  const perToken: { [token: string]: number } = {};
  let a = 0;
  let r = 0;
  for (const tok of legacy.literalTokens) {
    const ta = lineCount(addedScan, tok);
    const tr = lineCount(removedScan, tok);
    perToken[tok] = ta - tr;
    a += ta;
    r += tr;
  }
  const ea = reCount(addedScan, legacy.emptyCatchPattern);
  const er = reCount(removedScan, legacy.emptyCatchPattern);
  perToken['empty-catch'] = ea - er;
  a += ea;
  r += er;

  // Defect: one aggregate net across every token class.
  return { exit: a - r > 0 ? 1 : 0, perToken };
}

// Map a checker token class onto the legacy counter that covered it, so the
// undercount controls compare like with like. The legacy gate had no separate
// null/undefined/block classes at all, which is the point.
function legacyCountFor(result: LegacyResult, token: string): number {
  if (token.startsWith('empty-catch')) {
    return (
      result.perToken['empty-catch'] +
      FIXTURES.legacyAlgorithm.emptyCatchLiterals.reduce(
        (sum, l) => sum + (result.perToken[l] ?? 0),
        0,
      )
    );
  }
  return result.perToken[token] ?? 0;
}

// ---------------------------------------------------------------------------

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

describe('R75 gate — policy data', () => {
  it('the checker and its policy files exist', () => {
    expect(existsSync(CHECKER)).toBe(true);
    expect(existsSync(POLICY)).toBe(true);
  });

  it('the policy declares scan scope and tokens as data', () => {
    const policy = JSON.parse(REAL_POLICY);
    expect(policy.scan.includeExtensions.length).toBeGreaterThan(0);
    expect(policy.scan.includeRoots).toEqual(['src/', 'scripts/']);
    expect(policy.scan.includeFiles).toEqual(['dangerfile.js']);
    expect(policy.tokens.length).toBeGreaterThan(0);
  });

  it('the skipped test files are exactly the ones the production build leaves out', () => {
    // Owner ruling #192-D6 op 1: skip only what cannot reach clients. The build
    // compiles src/**/* except **/*spec.ts; test/ and top-level __tests__/ are
    // never inside it. Anything wider (for example *.test.ts, or a src/
    // __tests__/ helper the build compiles) must stay scanned. Ruling R-R75-1:
    // the src/ skip is the build glob WITH the dot, src/**/*.spec.ts, because
    // tsc still compiles an excluded file that app code imports
    // (src/scout/reconstruct/mapping-spec.ts). A change to either side fails.
    const build = JSON.parse(readFileSync(BUILD_TSCONFIG, 'utf8'));
    expect(build.include).toEqual(['src/**/*']);
    expect(build.exclude).toContain('test');
    const buildGlobs = build.exclude.filter((entry: string) => entry.includes('*'));
    expect(buildGlobs).toEqual(['**/*spec.ts']);
    const scan = JSON.parse(REAL_POLICY).scan;
    expect(scan.excludeRootGlobs).toEqual(['src/**/*.spec.ts']);
    expect(scan.excludeRootGlobs).toEqual(
      buildGlobs.map((glob: string) => `src/${glob.replace('*spec.ts', '*.spec.ts')}`),
    );
    expect(scan.includeRoots).not.toContain('test/');
    expect(scan.includeRoots).not.toContain('__tests__/');
    expect(scan.excludeSuffixes).toEqual([]);
    expect(scan.excludeSegments).toEqual([]);
  });

  it('no scanned src/ or scripts/ file imports a skipped file (repository tree)', () => {
    // Ruling R-R75-1: a skipped file must be one nothing the gate scans pulls
    // in. tsc compiles an excluded file that app code imports, so a src/ file
    // importing a skipped file would put an unscanned file into the build.
    const scan = JSON.parse(REAL_POLICY).scan;
    const roots: string[] = scan.includeRoots;
    const files: string[] = scan.includeFiles;
    const extensions: string[] = scan.includeExtensions;
    const globs = scan.excludeRootGlobs.map((glob: string) => {
      const match = /^([^*]+\/)\*\*\/\*([^*/]+)$/.exec(glob);
      if (!match) throw new Error(`unsupported exclude glob: ${glob}`);
      return { root: match[1], suffix: match[2] };
    });
    const skippedByGlob = (path: string): boolean =>
      globs.some(({ root, suffix }: { root: string; suffix: string }) => path.startsWith(root) && path.endsWith(suffix));
    const scanned = (path: string): boolean =>
      (roots.some((root) => path.startsWith(root)) || files.includes(path)) &&
      extensions.some((extension) => path.endsWith(extension)) &&
      !skippedByGlob(path);
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    const trackedSet = new Set(tracked);
    // A skipped file: test sources outside the roots, or a src/ file the glob skips.
    const skipped = (path: string): boolean =>
      !scanned(path) && (path.startsWith('test/') || path.startsWith('__tests__/') || skippedByGlob(path));
    const codeExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.cjs', '.mjs'];
    const resolve = (from: string, specifier: string): string | undefined => {
      // Relative specifiers, plus the tsconfig baseUrl "./" form (src/..., test/...).
      const base = specifier.startsWith('.')
        ? join(dirname(from), specifier).split('\\').join('/')
        : specifier;
      const candidates = [base, ...codeExtensions.map((e) => base + e), ...codeExtensions.map((e) => `${base}/index${e}`)];
      return candidates.find((candidate) => trackedSet.has(candidate));
    };
    const importPattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
    const edges: string[] = [];
    for (const path of tracked) {
      if (!scanned(path) || !codeExtensions.some((extension) => path.endsWith(extension))) continue;
      const source = readFileSync(join(REPO_ROOT, path), 'utf8');
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        if (!/^(\.{1,2}\/|src\/|test\/|scripts\/|__tests__\/)/.test(specifier)) continue;
        const target = resolve(path, specifier);
        if (target && skipped(target)) edges.push(`${path} -> ${target}`);
      }
    }
    const unique = [...new Set(edges)].sort();
    // App code never imports a skipped file.
    expect(unique.filter((edge) => edge.startsWith('src/'))).toEqual([]);
    // Two operator scripts import test/ helpers at the base (02a904a6). Neither
    // side is in the production build (tsconfig.build.json excludes both
    // "scripts" and "test"), so nothing here reaches clients; the list is
    // pinned so any new scripts/ -> skipped import fails this test.
    expect(unique.filter((edge) => !edge.startsWith('src/'))).toEqual([
      'scripts/eval-roman-live.ts -> test/ai-egress/ai-egress.fakes.ts',
      'scripts/eval-roman-live.ts -> test/roman/eval/golden-set.ts',
      'scripts/eval-roman-live.ts -> test/roman/eval/harness.ts',
      'scripts/eval-roman-live.ts -> test/roman/fixtures/roman-personas.ts',
      'scripts/gen-operator-keys.ts -> test/prod-readiness/operator-keys-generator.ts',
      'scripts/gen-operator-keys.ts -> test/prod-readiness/provider-wiring.ts',
      'scripts/gen-operator-keys.ts -> test/prod-readiness/registry-loader.ts',
    ]);
    // The R-R75-1 file itself is scanned and is imported by app code.
    expect(scanned('src/scout/reconstruct/mapping-spec.ts')).toBe(true);
  });

  it('the swallowed-error returns are three distinct token classes', () => {
    // Aggregating them would let a deleted null-returning catch pay for an
    // introduced undefined-returning one.
    const names = JSON.parse(REAL_POLICY).tokens.map((t: { name: string }) => t.name);
    for (const cls of FIXTURES.policyExpectations.emptyCatchClasses) {
      expect(names).toContain(cls);
    }
  });

  it('the suppression rule states no length or character requirement', () => {
    // The token name comes from fixture data: naming it in executable test
    // source would make this suite an R75 violation against its own gate.
    const suppressions = JSON.parse(REAL_POLICY).suppressions;
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0].token).toBe(FIXTURES.policyExpectations.suppressionToken);
    expect(Object.keys(suppressions[0])).not.toContain('reasonMinChars');
  });
});

describe('R75 gate — repository checker against real Git repositories', () => {
  it.each(FIXTURES.cases.map((c) => [c.name, c] as [string, GateCase]))(
    'case: %s',
    (_name, testCase) => {
      const repo = newRepo();
      let range: string | null = null;
      let base = '';

      installPolicy(repo, REAL_POLICY);

      if (testCase.mode === 'range') {
        writeFiles(repo, testCase.base ?? {});
        git(repo, ['add', '-A', '-f']);
        git(repo, ['commit', '-q', '-m', 'base']);
        base = git(repo, ['rev-parse', 'HEAD']);
        for (const [from, to] of Object.entries(testCase.renameTo ?? {})) {
          mkdirSync(dirname(join(repo, to)), { recursive: true });
          git(repo, ['mv', from, to]);
        }
        for (const path of testCase.deletePaths ?? []) {
          git(repo, ['rm', '-q', path]);
        }
        writeFiles(repo, testCase.head ?? {});
        git(repo, ['add', '-A', '-f']);
        git(repo, ['commit', '-q', '--allow-empty', '-m', 'head']);
        range = `${base}...${git(repo, ['rev-parse', 'HEAD'])}`;
      } else {
        writeFiles(repo, testCase.staged ?? {});
        git(repo, ['add', '-A', '-f']);
        // Unstaged bytes are written AFTER staging so the index and the working
        // tree genuinely diverge.
        if (testCase.unstaged) writeFiles(repo, testCase.unstaged);
        if (testCase.weakenWorkingTreePolicy) installPolicy(repo, WEAK_POLICY);
      }

      const args =
        testCase.mode === 'range' ? ['--mode=range', `--base=${base}`] : ['--mode=staged'];
      const result = runChecker(repo, args);

      expect(result.status).toBe(testCase.expectExit);

      for (const [token, net] of Object.entries(testCase.expectNet ?? {})) {
        // A class with no movement at all is not printed; net 0 is then implied.
        if (net === 0 && reportedNet(result.stdout, token) === undefined) continue;
        expect(reportedNet(result.stdout, token)).toBe(net);
      }
      for (const offender of testCase.expectOffenders ?? []) {
        expect(result.stdout).toContain(`${offender}: +`);
      }
      for (const file of testCase.expectEvidenceFiles ?? []) {
        expect(result.stdout).toContain(file);
      }
      for (const file of testCase.expectAbsentFiles ?? []) {
        expect(result.stdout).not.toContain(file);
      }
      if (testCase.expectExit === 1) {
        // Diagnostics must survive: a bare non-zero exit is not actionable.
        expect(result.stdout).toContain('FAIL');
        expect(result.stdout).toMatch(/net \+/);
      }
      if (testCase.expectExit === 0) {
        expect(result.stdout).toContain('OK —');
      }

      if (testCase.legacyExit !== undefined) {
        const legacy = legacyScan(repo, range, FIXTURES.legacyAlgorithm);
        expect(legacy.exit).toBe(testCase.legacyExit);
        if (testCase.control === 'verdict') {
          expect(legacy.exit).not.toBe(result.status);
        }
        if (testCase.control === 'undercount') {
          const token = testCase.controlToken as string;
          expect(legacyCountFor(legacy, token)).toBeLessThan(
            reportedNet(result.stdout, token) as number,
          );
        }
      }
    },
  );
});

describe('R75 gate — operational failures never degrade to a green pass', () => {
  it('uses the merge base and explicit head rather than the checked-out diverged base', () => {
    const repo = newRepo();
    installPolicy(repo, REAL_POLICY);
    git(repo, ['add', '-A', '-f']);
    git(repo, ['commit', '-q', '-m', 'common ancestor']);
    const ancestor = git(repo, ['rev-parse', 'HEAD']);
    const token = JSON.parse(REAL_POLICY).tokens[0].name;
    writeFiles(repo, { 'src/feature.ts': [`// ${token}`] });
    git(repo, ['add', '-A', '-f']);
    git(repo, ['commit', '-q', '-m', 'feature']);
    const feature = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-q', '-b', 'diverged-base', ancestor]);
    writeFiles(repo, { 'src/base.ts': [`// ${token}`] });
    git(repo, ['add', '-A', '-f']);
    git(repo, ['commit', '-q', '-m', 'base advanced independently']);
    const result = runChecker(repo, ['--mode=range', '--base=HEAD', `--head=${feature}`]);

    expect(result.status).toBe(1);
    expect(reportedNet(result.stdout, token)).toBe(1);
    expect(result.stdout).toContain('src/feature.ts');
    expect(result.stdout).not.toContain('src/base.ts');
  });

  const operationalCases = FIXTURES.operationalCases.flatMap((c) =>
    c.stagePolicy === undefined
      ? [c]
      : [c, { ...c, name: `${c.name} (range)`, args: ['--mode=range', '--base=HEAD'] }],
  );
  it.each(operationalCases.map((c) => [c.name, c] as [string, OperationalCase]))(
    'case: %s',
    (_name, testCase) => {
      const repo = newRepo();
      installPolicy(repo, REAL_POLICY);
      git(repo, ['add', '-A', '-f']);
      git(repo, ['commit', '-q', '-m', 'base']);
      if (testCase.stagePolicy !== undefined) {
        installPolicy(repo, testCase.stagePolicy);
        git(repo, ['add', '-A', '-f']);
        if (testCase.args.includes('--mode=range')) {
          git(repo, ['commit', '-q', '-m', 'unusable policy']);
        }
      }

      const result = runChecker(repo, testCase.args);
      expect(result.status).toBe(testCase.expectExit);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('operational failure');
      if (testCase.expectStderr) expect(result.stderr).toContain(testCase.expectStderr);
      expect(result.stdout).not.toContain('OK —');
    },
  );

  it.each(['staged', 'range'])('a Git failure surfaces in %s mode', (mode) => {
    const notARepo = mkdtempSync(join(tmpdir(), 'r75-nogit-'));
    tempRoots.push(notARepo);
    const args = mode === 'range' ? ['--mode=range', '--base=HEAD'] : ['--mode=staged'];
    const result = runChecker(notARepo, args);
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('OK —');
  });

  it.each(['staged', 'range'])('a missing policy fails in %s mode', (mode) => {
    const repo = newRepo();
    writeFiles(repo, { 'src/a.ts': ['const clean = 1;'] });
    git(repo, ['add', '-A', '-f']);
    if (mode === 'range') git(repo, ['commit', '-q', '-m', 'no policy']);
    const args = mode === 'range' ? ['--mode=range', '--base=HEAD'] : ['--mode=staged'];
    const result = runChecker(repo, args);
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('OK —');
  });
});

describe('R75 gate — CI and the pre-commit hook invoke the one committed checker', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const hooks = readFileSync(HOOKS, 'utf8');
  const checkerRef = 'scripts/check-r75.js';

  it('the CI banned-casts job runs the checker in explicit range mode', () => {
    expect(workflow).toContain(`node ${checkerRef} --mode=range`);
    expect(workflow).toContain('--base="$BASE_SHA"');
  });

  it('the pre-commit hook runs the same checker in staged mode', () => {
    expect(hooks).toContain(`node ${checkerRef} --mode=staged`);
  });

  it('neither surface keeps a second, divergent token implementation', () => {
    expect(workflow).not.toMatch(/grep\s+-c/);
    expect(hooks).not.toMatch(/grep\s+-c/);
  });

  it('workflow_dispatch is explicitly non-certifying rather than fabricating a base', () => {
    expect(workflow).toContain('NON-CERTIFYING RUN');
    expect(workflow).toMatch(/pull_request event carried no base SHA/);
  });

  // The former `loc-budget` / `test-density` jobs were retired (G01/G08); the
  // workflow now has only `banned-casts`. That invariant is asserted by
  // test/ci/delivery-artifact.spec.ts, and the absence of any inline pathspec or
  // token list by test/ci/r100-pathspec.spec.ts.
});

// R75-BASE-POLICY-BE (#194-D1 op 1): CI passes --policy-base=<the base branch's
// head>, so a change is judged by the rules it would merge into. It can neither
// loosen its own check by editing the policy file nor keep a stale copy of the
// policy from before a newer one landed on the base.
describe('R75 gate — the rules come from the base, never from the head', () => {
  const vectors: { tokens: { name: string; input: string }[] } = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'r75-boundaries.json'), 'utf8'),
  );
  const castToken = 'as unknown as';
  const cast = vectors.tokens.find((entry) => entry.name === castToken)?.input;
  if (!cast) throw new Error(`fixture vector missing: ${castToken}`);
  const real = JSON.parse(REAL_POLICY);
  // Parses and validates, but bans nothing any case writes.
  const BANS_NOTHING = JSON.stringify({
    scan: real.scan,
    tokens: [{ name: 'zzz-not-a-real-token', pattern: 'zzz-not-a-real-token' }],
  });
  // The policy before b#1208: src/ files ending .spec.ts were still scanned.
  const SCANS_SPEC_FILES = JSON.stringify({
    ...real,
    scan: { ...real.scan, excludeRootGlobs: [] },
  });

  function commit(repo: string, files: FileMap, policy?: string): string {
    if (policy !== undefined) installPolicy(repo, policy);
    writeFiles(repo, files);
    git(repo, ['add', '-A', '-f']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'step']);
    return git(repo, ['rev-parse', 'HEAD']);
  }

  function range(repo: string, base: string, head: string, policyBase?: string) {
    const args = ['--mode=range', `--base=${base}`, `--head=${head}`];
    return runChecker(repo, policyBase ? [...args, `--policy-base=${policyBase}`] : args);
  }

  it('a head that bans nothing still fails a new cast the base policy bans', () => {
    const repo = newRepo();
    const base = commit(repo, { 'src/keep.ts': ['export const keep = 1;'] }, REAL_POLICY);
    const head = commit(repo, { 'src/feature.ts': [cast] }, BANS_NOTHING);

    const judged = range(repo, base, head, base);
    expect(judged.status).toBe(1);
    expect(reportedNet(judged.stdout, castToken)).toBe(1);
    expect(judged.stdout).toContain('src/feature.ts');
    expect(judged.stdout).toContain(`policy from base ${base}`);
    expect(judged.stdout).toContain(
      `note: this change edits ${POLICY_IN_REPO}; it is judged by the base's file, not its own`,
    );
    expect(judged.stdout).not.toContain('zzz-not-a-real-token');

    // Control: read from the head, the loosened file lets the same cast through.
    const own = range(repo, base, head);
    expect(own.status).toBe(0);
    expect(own.stdout).toContain('OK — no positive token change');
  });

  it('a branch built before a policy change is judged by the base branch newest policy', () => {
    const repo = newRepo();
    const fork = commit(repo, { 'src/keep.ts': ['export const keep = 1;'] }, SCANS_SPEC_FILES);
    git(repo, ['checkout', '-q', '-b', 'feature']);
    const head = commit(repo, { 'src/feature.spec.ts': [cast], 'test/feature.spec.ts': [cast] });
    git(repo, ['checkout', '-q', '-b', 'newer-main', fork]);
    const newest = commit(repo, {}, REAL_POLICY);

    const judged = range(repo, fork, head, newest);
    expect(judged.status).toBe(0);
    expect(judged.stdout).toContain(`policy from base ${newest}`);
    expect(judged.stdout).toContain('OK — no positive token change');
    expect(judged.stdout).not.toContain('note: this change edits');

    // Control: the stale copy at the head still scans the src/ spec file.
    const stale = range(repo, fork, head);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain('src/feature.spec.ts');
  });

  it('under the base policy a skipped test file stays skipped; app code still counts', () => {
    const repo = newRepo();
    const base = commit(repo, { 'src/keep.ts': ['export const keep = 1;'] }, REAL_POLICY);
    const head = commit(repo, {
      'src/feature.spec.ts': [cast],
      'test/feature.spec.ts': [cast],
      '__tests__/feature.ts': [cast],
      'src/app.ts': [cast],
    });

    const judged = range(repo, base, head, base);
    expect(judged.status).toBe(1);
    expect(reportedNet(judged.stdout, castToken)).toBe(1);
    expect(judged.stdout).toContain('src/app.ts');
    const skipped = ['src/feature.spec.ts', 'test/feature.spec.ts', '__tests__/feature.ts'];
    for (const path of skipped) expect(judged.stdout).not.toContain(path);
  });

  it('a local run with no policy argument still reads today\'s path at the measured head', () => {
    const repo = newRepo();
    const base = commit(repo, { 'src/keep.ts': ['export const keep = 1;'] }, REAL_POLICY);
    const head = commit(repo, { 'src/feature.ts': [cast] });

    const local = range(repo, base, head);
    expect(local.status).toBe(1);
    expect(local.stdout).toContain(`policy=${head}:${POLICY_IN_REPO}`);
    expect(local.stdout).not.toContain('policy from base');

    writeFiles(repo, { 'src/staged.ts': [cast] });
    git(repo, ['add', '-A', '-f']);
    const staged = runChecker(repo, ['--mode=staged']);
    expect(staged.status).toBe(1);
    expect(staged.stdout).toContain(`policy=:${POLICY_IN_REPO}`);
  });

  const rejected: [string, string[], string][] = [
    ['staged mode', ['--mode=staged', '--policy-base=HEAD'], 'staged mode does not accept'],
    ['an empty value', ['--mode=range', '--base=HEAD', '--policy-base='], 'nonempty policy base'],
    ['a blank value', ['--mode=range', '--base=HEAD', '--policy-base=  '], 'nonempty policy base'],
    ['a non-commit', ['--mode=range', '--base=HEAD', '--policy-base=nope'], 'git failed'],
    [
      'a repeated option',
      ['--mode=range', '--base=HEAD', '--policy-base=HEAD', '--policy-base=HEAD'],
      'duplicate',
    ],
  ];
  it.each(rejected)('rejects --policy-base with %s', (_name, args, reason) => {
    const repo = newRepo();
    commit(repo, { 'src/keep.ts': ['export const keep = 1;'] }, REAL_POLICY);
    const result = runChecker(repo, args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('operational failure');
    expect(result.stderr).toContain(reason);
    expect(result.stdout).not.toContain('OK —');
  });

  it('a base with no policy file fails closed instead of falling back to the head', () => {
    const repo = newRepo();
    const base = commit(repo, { 'src/keep.ts': ['export const keep = 1;'] });
    const head = commit(repo, { 'src/feature.ts': ['export const clean = 2;'] }, REAL_POLICY);
    const result = range(repo, base, head, base);
    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain('invalid or duplicate argument');
    expect(result.stdout).not.toContain('OK —');
  });
});
