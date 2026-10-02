// B-FLAGS-2 PR 2 (T4, CI-gate file): proves the shellcheck SC2015 fix in
// scripts/s10-core-diff-gate.sh changes no decision.
//
// The fix rewrites the gate's three `A && B || fail ...` lists as
// `if ! { A && B; }; then fail ...; fi`. Both forms call `fail` exactly when
// A && B is false, but shellcheck 0.9 (ubuntu-latest) flags the first one, so
// the infra-lint shellcheck job fails on main.
//
// Two proofs:
//   1. Text: undoing those three rewrites in the shipped script gives back the
//      pre-fix copy (test/ci/fixtures/s10-core-diff-gate.pre-sc2015.sh) byte
//      for byte, so nothing else changed.
//   2. Behaviour: the shipped script and the pre-fix copy run as real child
//      processes against the same real temporary Git repositories and the same
//      arguments. For every case (each branch of the three rewritten
//      conditionals, the pass path and every other check that fails), the exit
//      status, stdout and stderr must be identical, and each case must reach
//      the decision it was built for.
// `rg` is a small shim on PATH (the gate's only rg call is
// `rg -F -l s10_unseen src --type ts`), so both scripts see the same tool on a
// runner without ripgrep.

import { execFileSync, spawnSync } from 'child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..');
const GATE = join(REPO_ROOT, 'scripts', 's10-core-diff-gate.sh');
const PRE_FIX = join(__dirname, 'fixtures', 's10-core-diff-gate.pre-sc2015.sh');

const ALLOWED = [
  'src/scout/induction/sources/s10_unseen.json',
  'src/scout/reconstruct/native/sources/s10_unseen.json',
  'src/scout/reconstruct/sources/s10_unseen.json',
  'test/fixtures/scout/s10_unseen/signer-test-key.json',
  'test/fixtures/scout/s10_unseen/staged-rows.json',
  'test/fixtures/scout/s10_unseen/statements.json',
  'test/scout/s10/s10-unseen.e2e.spec.ts',
  'test/scout/s10/s10-unseen.pg.spec.ts',
];

const RG_SHIM = `#!/usr/bin/env bash
# rg shim for s10-core-diff-gate-sc2015.spec.ts: supports only the gate's call.
if [ "$*" != "-F -l s10_unseen src --type ts" ]; then
  echo "rg shim: unexpected arguments: $*" >&2
  exit 2
fi
if [ ! -d src ]; then
  echo "rg shim: src: No such file or directory" >&2
  exit 2
fi
if out="$(grep -rlF --include='*.ts' s10_unseen src)"; then
  printf '%s\\n' "$out" | LC_ALL=C sort
  exit 0
fi
exit 1
`;

type Variant =
  'pass' | 'executable' | 'symlink' | 'extra-path' | 'dirty' | 'slug-in-src' | 'vocab-missing';

interface Repo {
  dir: string;
  base: string;
  head: string;
  tag: string;
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: dir,
    },
  }).trim();
}

function write(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function makeRepo(variant: Variant): Repo {
  const dir = mkdtempSync(join(tmpdir(), 's10-gate-'));
  tempDirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'docs/contracts/importer-openapi.json', '{}\n');
  write(
    dir,
    'src/scout/induction/contract.ts',
    'export const COMPLETENESS_BASIS_KINDS = [];\nexport const OBSERVATION_CONFLICT_CODES = [];\n',
  );
  if (variant !== 'vocab-missing')
    write(dir, 'src/scout/lifecycle/reason-codes.ts', 'export const RUN_REASON_CODES = [];\n');
  write(
    dir,
    'src/index.ts',
    variant === 'slug-in-src' ? "export const slug = 's10_unseen';\n" : 'export {};\n',
  );
  write(dir, 'README.md', 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'tag', '-a', '-m', 'annotated', 'base-tag', base);
  const tag = git(dir, 'rev-parse', 'base-tag');
  for (const p of ALLOWED) write(dir, p, p.endsWith('.json') ? '{}\n' : 'export {};\n');
  if (variant === 'executable') chmodSync(join(dir, ALLOWED[0]), 0o755);
  if (variant === 'symlink') {
    rmSync(join(dir, ALLOWED[1]));
    symlinkSync('../../../../README.md', join(dir, ALLOWED[1]));
  }
  if (variant === 'extra-path') write(dir, 'src/scout/extra.json', '{}\n');
  git(dir, 'add', '-A');
  if (variant === 'executable') git(dir, 'update-index', '--chmod=+x', ALLOWED[0]);
  git(dir, 'commit', '-q', '-m', 'head');
  if (variant === 'dirty') write(dir, 'untracked.txt', 'x\n');
  return { dir, base, head: git(dir, 'rev-parse', 'HEAD'), tag };
}

interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runGate(script: string, repo: Repo, args: string[]): Outcome {
  const bin = join(repo.dir, '.shim-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'rg'), RG_SHIM, { mode: 0o755 });
  const r = spawnSync('bash', [script, ...args], {
    cwd: repo.dir,
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: repo.dir, LC_ALL: 'C' },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Keep the shim directory out of `git status` (check 2) for both scripts.
function ignoreShim(repo: Repo): void {
  write(repo.dir, '.git/info/exclude', '.shim-bin/\n');
}

describe('s10-core-diff-gate.sh SC2015 fix: text', () => {
  it('undoing the three if-rewrites gives back the pre-fix script byte for byte', () => {
    const shipped = readFileSync(GATE, 'utf8');
    const pre = readFileSync(PRE_FIX, 'utf8');
    const rewrites = [...shipped.matchAll(/^( *)if ! \{ (.+); \}; then\n\1 {2}(fail .+)\n\1fi$/gm)];
    expect(rewrites).toHaveLength(3);
    const undone = shipped.replace(
      /^( *)if ! \{ (.+); \}; then\n\1 {2}(fail .+)\n\1fi$/gm,
      (_m, indent: string, cond: string, call: string) => `${indent}${cond} || ${call}`,
    );
    const preJoined = pre.replace(/\|\|\n {4}fail /g, '|| fail ');
    expect(undone).toBe(preJoined);
  });

  it('no `A && B || C` list is left in the gate', () => {
    // Join `||` continuation lines so a list split over two lines is seen whole.
    const code = readFileSync(GATE, 'utf8')
      .replace(/\|\|\n\s*/g, '|| ')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l));
    for (const line of code) expect([line, /&&.*\|\|/.test(line)]).toEqual([line, false]);
    // Negative control: the same scan finds the three lists in the pre-fix copy.
    const pre = readFileSync(PRE_FIX, 'utf8')
      .replace(/\|\|\n\s*/g, '|| ')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && /&&.*\|\|/.test(l));
    expect(pre).toHaveLength(3);
  });
});

describe('s10-core-diff-gate.sh SC2015 fix: identical decisions', () => {
  const repos = new Map<Variant, Repo>();
  const repo = (v: Variant): Repo => {
    if (!repos.has(v)) {
      const r = makeRepo(v);
      ignoreShim(r);
      repos.set(v, r);
    }
    return repos.get(v)!;
  };

  type Case = [string, Variant, (r: Repo) => string[], number, RegExp];
  const cases: Case[] = [
    // Rewrite 1: argument count (both branches).
    ['no arguments', 'pass', () => [], 1, /FAIL \[args\] usage:/],
    ['three arguments', 'pass', (r) => [r.base, 'HEAD', 'extra'], 1, /FAIL \[args\] usage:/],
    ['one argument passes the count check', 'pass', (r) => [r.base], 0, /PASS B=/],
    ['two arguments pass the count check', 'pass', (r) => [r.base, 'HEAD'], 0, /PASS B=/],
    // Rewrite 2: B resolves to a commit and equals the argument (each clause).
    [
      'B is 40-hex but not an object',
      'pass',
      () => ['0123456789abcdef0123456789abcdef01234567'],
      1,
      /FAIL \[args\] B is not a commit:/,
    ],
    [
      'B is an annotated tag object (resolves, but to another id)',
      'pass',
      (r) => [r.tag],
      1,
      /FAIL \[args\] B is not a commit:/,
    ],
    [
      'B is not 40-hex',
      'pass',
      () => ['abc'],
      1,
      /FAIL \[args\] B must be a full 40-hex commit id/,
    ],
    [
      'HEAD argument is not the checked-out HEAD',
      'pass',
      (r) => [r.base, r.base],
      1,
      /FAIL \[args\] <HEAD> .* must be the checked-out HEAD/,
    ],
    ['B equals HEAD', 'pass', (r) => [r.head], 1, /FAIL \[args\] B equals HEAD/],
    // Rewrite 3: each allowed path is a 100644 blob (mode clause, type clause).
    [
      'an allowed path is executable (100755)',
      'executable',
      (r) => [r.base],
      1,
      /FAIL \[3\] allowed path is not a regular 100644 blob at HEAD \(mode 100755, type blob\)/,
    ],
    [
      'an allowed path is a symlink (120000)',
      'symlink',
      (r) => [r.base],
      1,
      /FAIL \[3\] allowed path is not a regular 100644 blob at HEAD \(mode 120000, type blob\)/,
    ],
    // The other checks still decide the same way.
    [
      'a changed path outside the allowed set',
      'extra-path',
      (r) => [r.base],
      1,
      /FAIL \[3\] changed paths differ from the allowed set/,
    ],
    ['an untracked file', 'dirty', (r) => [r.base], 1, /FAIL \[2\] working tree not clean/],
    ['the slug in src', 'slug-in-src', (r) => [r.base], 1, /FAIL \[5\] rg over HEAD src exited 0/],
    [
      'a vocabulary file absent at B',
      'vocab-missing',
      (r) => [r.base],
      1,
      /FAIL \[7\] vocabulary file absent at B/,
    ],
  ];

  it.each(cases)(
    '%s: same status, stdout and stderr as the pre-fix script',
    (_label, variant, args, status, decision) => {
      const r = repo(variant);
      const a = args(r);
      const shipped = runGate(GATE, r, a);
      const pre = runGate(PRE_FIX, r, a);
      expect(shipped).toEqual(pre);
      expect(shipped.status).toBe(status);
      expect(`${shipped.stdout}${shipped.stderr}`).toMatch(decision);
    },
  );
});
