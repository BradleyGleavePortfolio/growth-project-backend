// Executable regression tests for the R75 / R100.A2 banned-token gate.
//
// These run the repository checker (scripts/check-r75.js) as a real child process
// against real temporary Git repositories and a real index. Nothing here
// re-implements the gate: a test reasoning about its own copy of the algorithm
// would pass while the shipped gate stayed broken, which is how the pre-repair
// gate survived.
//
// Every banned literal used as input lives in fixtures/r75-cases.json, because
// .json is not an executable extension in .github/r75-policy.json. This file,
// being executable test source, IS in the gate's scan scope.
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
    expect(policy.scan.includeRoots).toContain('test/');
    expect(policy.tokens.length).toBeGreaterThan(0);
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

  it('the LOC and density jobs keep their own measurement pathspecs', () => {
    // Ownership boundary: this repair touches the banned-casts job only.
    expect(workflow).toContain('loc-budget:');
    expect(workflow).toContain('test-density:');
    expect(workflow).toContain(":(glob)scripts/**/*.js'");
  });
});
