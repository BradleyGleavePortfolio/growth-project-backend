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
// This intermediate slice supports the range-mode CI contract. Staged-mode
// hook tests and the legacy negative comparator land with the following slice.

import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..');
const CHECKER = join(REPO_ROOT, 'scripts', 'check-r75.js');
const POLICY_IN_REPO = '.github/r75-policy.json';
const POLICY = join(REPO_ROOT, POLICY_IN_REPO);
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'r100-quality-gate.yml');

interface FileMap {
  [path: string]: string[];
}

interface GateCase {
  name: string;
  mode: 'range' | 'staged';
  base?: FileMap;
  head?: FileMap;
  renameTo?: { [from: string]: string };
  deletePaths?: string[];
  expectExit: number;
  expectNet?: { [token: string]: number };
  expectOffenders?: string[];
  expectEvidenceFiles?: string[];
  why: string;
}

interface OperationalCase {
  name: string;
  args: string[];
  expectExit: number;
  // Policy fixtures use the real repository path, with no filesystem override.
  // This range-only slice commits malformed policy bytes into the target head
  // so the production range-policy read is exercised.
  stagePolicy?: string;
}

const FIXTURES = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'r75-cases.json'), 'utf8'),
) as {
  policyExpectations: { suppressionToken: string; emptyCatchClasses: string[] };
  cases: GateCase[];
  operationalCases: OperationalCase[];
};

const REAL_POLICY = readFileSync(POLICY, 'utf8');

const tempRoots: string[] = [];

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
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
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
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
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
  it.each(
    FIXTURES.cases.filter((c) => c.mode === 'range').map((c) => [c.name, c] as [string, GateCase]),
  )('case: %s', (_name, testCase) => {
    const repo = newRepo();
    installPolicy(repo, REAL_POLICY);
    writeFiles(repo, testCase.base ?? {});
    git(repo, ['add', '-A', '-f']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    for (const [from, to] of Object.entries(testCase.renameTo ?? {})) {
      mkdirSync(dirname(join(repo, to)), { recursive: true });
      git(repo, ['mv', from, to]);
    }
    for (const path of testCase.deletePaths ?? []) git(repo, ['rm', '-q', path]);
    writeFiles(repo, testCase.head ?? {});
    git(repo, ['add', '-A', '-f']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'head']);
    const result = runChecker(repo, ['--mode=range', `--base=${base}`]);

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
  });
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

  it.each(
    FIXTURES.operationalCases
      .filter((c) => c.stagePolicy !== undefined || !c.args.includes('--mode=staged'))
      .map((c) => [c.name, c] as [string, OperationalCase]),
  )('case: %s', (_name, testCase) => {
    const repo = newRepo();
    installPolicy(repo, REAL_POLICY);
    git(repo, ['add', '-A', '-f']);
    git(repo, ['commit', '-q', '-m', 'base']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    if (testCase.stagePolicy !== undefined) {
      installPolicy(repo, testCase.stagePolicy);
      git(repo, ['add', '-A', '-f']);
      git(repo, ['commit', '-q', '-m', 'invalid policy']);
    }

    const args =
      testCase.stagePolicy === undefined ? testCase.args : ['--mode=range', `--base=${base}`];
    const result = runChecker(repo, args);
    expect(result.status).toBe(testCase.expectExit);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('operational failure');
    expect(result.stdout).not.toContain('OK —');
  });

  it('a Git failure surfaces on stderr rather than producing an empty diff', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'r75-nogit-'));
    tempRoots.push(notARepo);
    const result = runChecker(notARepo, ['--mode=range', '--base=HEAD']);
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('OK —');
  });

  it('a repo with no committed policy fails instead of scanning with no rules', () => {
    const repo = newRepo();
    writeFiles(repo, { 'src/a.ts': ['const clean = 1;'] });
    git(repo, ['add', '-A', '-f']);
    git(repo, ['commit', '-q', '-m', 'no policy']);
    const result = runChecker(repo, ['--mode=range', '--base=HEAD']);
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('OK —');
  });
});

describe('R75 gate — CI invokes the committed range checker', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8');
  const checkerRef = 'scripts/check-r75.js';

  it('the CI banned-casts job runs the checker in explicit range mode', () => {
    expect(workflow).toContain(`node ${checkerRef} --mode=range`);
    expect(workflow).toContain('--base="$BASE_SHA"');
  });

  it('CI no longer keeps the divergent token implementation', () => {
    expect(workflow).not.toMatch(/grep\s+-c/);
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
