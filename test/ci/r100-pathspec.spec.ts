// Regression tests for the R100 quality-gate measurement scope. git pathspecs
// default to fnmatch with FNM_PATHNAME OFF, so a bare `src/**/*.ts` SKIPS a
// top-level file like src/main.ts; the :(glob) prefix makes `**` match
// zero-or-more segments. The first block exercises the exact
// `git diff -- <pathspec>` plumbing that motivated the fix. The workflow no
// longer carries any pathspec: the banned-casts job delegates to
// scripts/check-r75.js, whose scope is the `scan` block of
// .github/r75-policy.json (prefix/suffix filtering in code, so top-level files
// are in scope by construction). The second block guards that delegation and
// the policy data; the checker itself is executed by test/ci/r75-*.spec.ts.

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// What `git diff --numstat BASE..HEAD -- <pathspec>` would count as changed.
const diffNames = (cwd: string, range: string, pathspec: string[]): string[] =>
  git(cwd, ['diff', '--name-only', range, '--', ...pathspec])
    .split('\n')
    .filter(Boolean);

const FIXTURES = [
  'src/top.ts', // top-level .ts — the blind spot
  'src/nested/deep.ts',
  'src/top.js', // top-level .js — the extension blind spot
  'src/nested/widget.jsx',
  'src/top.spec.ts', // co-located spec, top level
  'src/nested/deep.spec.ts',
  'scripts/relevance.js', // production .js module under scripts/
  'scripts/helper.spec.js',
  'test/top.spec.ts',
  'dangerfile.js',
  '.github/workflows/gate.yml', // must NEVER be selected by code pathspecs
];

describe('R100 pathspec coverage (git diff — the gate plumbing)', () => {
  let repo: string;
  let range: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'r100-pathspec-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'test']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'base']);
    const base = git(repo, ['rev-parse', 'HEAD']);
    for (const f of FIXTURES) {
      mkdirSync(join(repo, f, '..'), { recursive: true });
      writeFileSync(join(repo, f), '// fixture\n');
    }
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'add fixtures']);
    range = `${base}..${git(repo, ['rev-parse', 'HEAD'])}`;
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('bare src/**/*.ts MISSES top-level files (documents the bug)', () => {
    expect(diffNames(repo, range, ['src/**/*.ts'])).not.toContain('src/top.ts');
  });

  it(':(glob) counts top-level AND nested .ts/.tsx/.js/.jsx under src, plus scripts .js', () => {
    const matched = diffNames(repo, range, [
      ':(glob)src/**/*.ts',
      ':(glob)src/**/*.tsx',
      ':(glob)src/**/*.js',
      ':(glob)src/**/*.jsx',
      ':(glob)scripts/**/*.js',
    ]);
    expect(matched).toEqual(
      expect.arrayContaining([
        'src/top.ts',
        'src/nested/deep.ts',
        'src/top.js',
        'src/nested/widget.jsx',
        'scripts/relevance.js', // the module that used to escape the denominator
      ]),
    );
  });

  it('the leading-**/ exclude drops co-located specs at top level AND nested', () => {
    const src = diffNames(repo, range, [
      ':(glob)src/**/*.ts',
      ':(glob)src/**/*.js',
      ':(exclude,glob)src/**/*.spec.*',
      ':(exclude,glob)src/**/*.test.*',
    ]);
    expect(src).toEqual(expect.arrayContaining(['src/top.ts', 'src/top.js']));
    expect(src).not.toContain('src/top.spec.ts');
    expect(src).not.toContain('src/nested/deep.spec.ts');
  });

  it('the TEST-side pathspec captures co-located specs and test/**', () => {
    const test = diffNames(repo, range, [
      ':(glob)test/**/*.ts',
      ':(glob)src/**/*.spec.*',
      ':(glob)scripts/**/*.spec.*',
    ]);
    expect(test).toEqual(
      expect.arrayContaining(['test/top.spec.ts', 'src/top.spec.ts', 'scripts/helper.spec.js']),
    );
  });

  it('the code pathspecs NEVER select a workflow under .github/** (removed exclude was a no-op)', () => {
    const codeScope = diffNames(repo, range, [
      ':(glob)src/**/*.ts',
      ':(glob)scripts/**/*.js',
      'dangerfile.js',
      ':(glob)test/**/*.ts',
    ]);
    expect(codeScope.some((f) => f.startsWith('.github/'))).toBe(false);
    expect(codeScope).toContain('dangerfile.js'); // control: in-scope file is present
  });
});

describe('R100 workflow delegates measurement scope to the committed checker and policy', () => {
  const yml = readFileSync(
    join(__dirname, '../../.github/workflows/r100-quality-gate.yml'),
    'utf8',
  );
  const policy = JSON.parse(
    readFileSync(join(__dirname, '../../.github/r75-policy.json'), 'utf8'),
  ) as {
    scan: {
      includeExtensions: string[];
      includeRoots: string[];
      includeFiles: string[];
      excludeSuffixes: string[];
      excludeSegments: string[];
    };
  };

  // Mirrors scripts/check-r75.js inScope() over the policy DATA so a scope
  // regression in the JSON is caught here; the checker's own behaviour against
  // real Git objects is covered by test/ci/r75-boundaries.spec.ts.
  const inPolicyScope = (path: string): boolean => {
    const { scan } = policy;
    if (
      scan.excludeSegments.some((part) => path.startsWith(part) || path.includes(`/${part}`)) ||
      scan.excludeSuffixes.some((suffix) => path.endsWith(suffix))
    ) {
      return false;
    }
    return (
      scan.includeFiles.includes(path) ||
      (scan.includeExtensions.some((suffix) => path.endsWith(suffix)) &&
        scan.includeRoots.some((root) => path.startsWith(root)))
    );
  };

  it('the banned-casts job runs the committed checker instead of an inline scan', () => {
    expect(yml).toContain('node scripts/check-r75.js --mode=range');
    expect(yml).toMatch(/--base="\$BASE_SHA"/);
    expect(yml).toMatch(/--head="\$HEAD_SHA"/);
  });

  it('carries no pathspec or token list of its own (no second implementation to drift)', () => {
    // Bare or :(glob) file-globs, a PATHSPEC array, or a grep-based counter in
    // the workflow would mean scope/tokens are defined in two places again.
    const bareFileGlob = /'[\w.-]+\/\*\*\/[^']*\.[A-Za-z]+'/g;
    expect(yml.match(bareFileGlob) ?? []).toEqual([]);
    expect(yml).not.toMatch(/:\((?:exclude,)?glob\)/);
    expect(yml).not.toMatch(/PATHSPEC=\(/);
    expect(yml).not.toMatch(/TOKENS=\(/);
    expect(yml).not.toMatch(/grep\s+-c/);
  });

  it('the header names the policy file as the scope authority, not a scope list', () => {
    expect(yml).toContain('.github/r75-policy.json');
    expect(yml).not.toMatch(/excluding \*\.d\.ts/);
  });

  it('policy scope covers top-level and nested src TS/JS, scripts .js and dangerfile.js', () => {
    for (const path of [
      'src/top.ts',
      'src/nested/deep.ts',
      'src/top.js',
      'src/nested/widget.jsx',
      'scripts/relevance.js',
      'dangerfile.js',
    ]) {
      expect({ path, scanned: inPolicyScope(path) }).toEqual({ path, scanned: true });
    }
  });

  it('policy scope includes test sources (R75 applies to tests) and never a workflow file', () => {
    expect(inPolicyScope('test/top.spec.ts')).toBe(true);
    expect(inPolicyScope('src/top.spec.ts')).toBe(true);
    expect(inPolicyScope('.github/workflows/gate.yml')).toBe(false);
    expect(inPolicyScope('.github/r75-policy.json')).toBe(false);
  });
});
