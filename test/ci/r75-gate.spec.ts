// Executable regression tests for the R75 / R100.A2 banned-cast gate.
//
// These tests run the COMMITTED checker (scripts/check-r75.js) as a real child
// process against real temporary Git repositories and, for hook parity, against
// a real Git index. Nothing here re-implements the gate: a test that reasoned
// about its own copy of the algorithm would pass while the shipped gate stayed
// broken, which is how the pre-repair gate survived.
//
// Every banned literal used as input lives in fixtures/r75-cases.json, because
// .json is not an executable extension in .github/r75-policy.json — so this
// suite can exercise hostile tokens without itself becoming an R75 violation.
// This file, being executable test source, IS in the gate's scan scope.
//
// Each case also carries a negative control: the deleted pre-repair shell
// algorithm (aggregate cross-token netting, grep -c line counting, whole-line
// suppression stripping, spec/test exclusion) is reproduced from fixture data
// and asserted to DISAGREE with the checker on the defect it repaired. If the
// checker silently regressed to the old semantics, the controls fail.

import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..');
const CHECKER = join(REPO_ROOT, 'scripts', 'check-r75.js');
const POLICY = join(REPO_ROOT, '.github', 'r75-policy.json');
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
  expectExit: number;
  expectNet?: { [token: string]: number };
  expectOffenders?: string[];
  expectEvidenceFiles?: string[];
  legacyExit: number;
  control?: 'verdict' | 'undercount';
  controlToken?: string;
  why: string;
}

interface OperationalCase {
  name: string;
  args: string[];
  expectExit: number;
  writePolicy?: string;
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
  legacyAlgorithm: LegacyPolicy;
  cases: GateCase[];
  operationalCases: OperationalCase[];
};

const tempRoots: string[] = [];

function newRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'r75-gate-'));
  tempRoots.push(repo);
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  };
  git(['init', '-q', '.']);
  git(['config', 'user.email', 'test@invalid.local']);
  git(['config', 'user.name', 'test']);
  git(['config', 'commit.gpgsign', 'false']);
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

interface CheckerResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runChecker(repo: string, args: string[]): CheckerResult {
  const res = spawnSync(process.execPath, [CHECKER, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

// Parse the checker's per-token report line: "  <token>   +A -R net N".
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
// fixture data so each case can prove it is sensitive to a real defect.
// ---------------------------------------------------------------------------

interface LegacyResult {
  exit: number;
  aggregateNet: number;
  perToken: { [token: string]: number };
}

function legacyScan(repo: string, range: string | null, legacy: LegacyPolicy): LegacyResult {
  const args = ['-c', 'core.quotepath=false', 'diff', '--unified=0', '--no-color'];
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
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4);
      currentNew = p === '/dev/null' ? null : p.replace(/^[ab]\//, '');
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++') && inLegacyScope(currentNew)) {
      added.push(raw.slice(1));
    } else if (raw.startsWith('-') && !raw.startsWith('---') && inLegacyScope(currentOld)) {
      removed.push(raw.slice(1));
    }
  }

  // Defect 4: the whole line is discarded when it carries a documented suppression.
  const exempt = new RegExp(legacy.exemptLinePattern);
  const keep = (lines: string[]): string[] => lines.filter((l) => !exempt.test(l));
  const addedScan = keep(added);
  const removedScan = keep(removed);

  // Defect 2: grep -c counts matching LINES, never occurrences.
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

  // Defect 1: one aggregate net across every token class.
  const aggregateNet = a - r;
  return { exit: aggregateNet > 0 ? 1 : 0, aggregateNet, perToken };
}

// Map a checker token name onto the legacy counter that covered it, so the
// undercount controls compare like with like.
function legacyCountFor(result: LegacyResult, token: string): number {
  if (token === 'empty-catch') {
    // The literal names come from fixture data: naming them in this executable
    // source would make the suite an R75 violation against its own gate.
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

describe('R75 gate — committed checker against real Git repositories', () => {
  it('the checker and its policy are committed and executable', () => {
    expect(existsSync(CHECKER)).toBe(true);
    expect(existsSync(POLICY)).toBe(true);
    const policy = JSON.parse(readFileSync(POLICY, 'utf8'));
    expect(policy.scan.includeExtensions.length).toBeGreaterThan(0);
    expect(policy.literalTokens.length + policy.patternTokens.length).toBeGreaterThan(0);
  });

  it.each(FIXTURES.cases.map((c) => [c.name, c] as [string, GateCase]))(
    'case: %s',
    (_name, testCase) => {
      const repo = newRepo();
      let range: string | null = null;

      if (testCase.mode === 'range') {
        writeFiles(repo, testCase.base ?? {});
        git(repo, ['add', '-A']);
        git(repo, ['commit', '-q', '--allow-empty', '-m', 'base']);
        const base = git(repo, ['rev-parse', 'HEAD']);
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
        git(repo, ['commit', '-q', '--allow-empty', '-m', 'base']);
        writeFiles(repo, testCase.staged ?? {});
        git(repo, ['add', '-A', '-f']);
        // Unstaged bytes are written AFTER staging so the index and the working
        // tree genuinely diverge.
        if (testCase.unstaged) writeFiles(repo, testCase.unstaged);
      }

      const args =
        testCase.mode === 'range'
          ? ['--mode=range', `--base=${(range as string).split('...')[0]}`]
          : ['--mode=staged'];
      const result = runChecker(repo, args);

      expect(result.status).toBe(testCase.expectExit);

      for (const [token, net] of Object.entries(testCase.expectNet ?? {})) {
        if (net === 0 && !result.stdout.includes(token)) continue; // no movement reported
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
        expect(result.stdout).toMatch(/FAIL/);
        expect(result.stdout).toMatch(/net \+/);
      }

      // Negative control.
      const legacy = legacyScan(repo, range, FIXTURES.legacyAlgorithm);
      expect(legacy.exit).toBe(testCase.legacyExit);
      if (testCase.control === 'verdict') {
        expect(legacy.exit).not.toBe(result.status);
      }
      if (testCase.control === 'undercount') {
        const token = testCase.controlToken as string;
        const trueNet = reportedNet(result.stdout, token) as number;
        expect(legacyCountFor(legacy, token)).toBeLessThan(trueNet);
      }
    },
  );
});

describe('R75 gate — operational failures never degrade to a green pass', () => {
  it.each(FIXTURES.operationalCases.map((c) => [c.name, c] as [string, OperationalCase]))(
    'case: %s',
    (_name, testCase) => {
      const repo = newRepo();
      git(repo, ['commit', '-q', '--allow-empty', '-m', 'base']);
      let args = testCase.args;
      if (testCase.writePolicy !== undefined) {
        const badPolicy = join(repo, 'bad-policy.json');
        writeFileSync(badPolicy, testCase.writePolicy);
        args = args.map((a) => a.replace('__UNUSABLE_POLICY__', badPolicy));
      }
      const result = runChecker(repo, args);
      expect(result.status).toBe(testCase.expectExit);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('operational failure');
    },
  );

  it('a Git failure surfaces on stderr rather than producing an empty diff', () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'r75-nogit-'));
    tempRoots.push(notARepo);
    const result = runChecker(notARepo, ['--mode=staged']);
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
    // The repaired gate has exactly one implementation. A re-introduced inline
    // grep over diff lines is the regression this guards.
    expect(workflow).not.toMatch(/grep\s+-c/);
    expect(hooks).not.toMatch(/grep\s+-c/);
    expect(workflow.match(new RegExp(checkerRef, 'g'))?.length ?? 0).toBeGreaterThan(0);
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
