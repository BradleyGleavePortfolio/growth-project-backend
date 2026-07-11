// Regression tests for the R100 quality-gate measurement pathspecs. git
// pathspecs default to fnmatch with FNM_PATHNAME OFF, so a bare `src/**/*.ts`
// SKIPS a top-level file like src/main.ts; the :(glob) prefix makes `**` match
// zero-or-more segments. Exercises the exact `git diff -- <pathspec>` plumbing.

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

describe('R100 workflow guards against reintroducing the bare pathspec', () => {
  const yml = readFileSync(
    join(__dirname, '../../.github/workflows/r100-quality-gate.yml'),
    'utf8',
  );

  // Semantic guard (finding #4): catch a bare quoted file-glob for ANY
  // directory ('<seg>/**/....<ext>' with no :(...glob...) prefix — the buggy
  // form). Bare directory recursion like 'src/**' is intentionally left alone.
  const bareFileGlob = /'[\w.-]+\/\*\*\/[^']*\.[A-Za-z]+'/g;
  const globbed = /:\((?:exclude,)?glob\)[\w.-]+\/\*\*\//g;

  it('uses :(glob) directory file-globs (guard is not vacuous)', () => {
    expect(yml.match(globbed)?.length ?? 0).toBeGreaterThan(0);
  });

  it('contains no bare directory file-glob pathspec (semantic regression guard)', () => {
    // Strip the glob'd forms first; any bare file-glob left is an offender
    // regardless of which directory it names.
    const withoutGlobbed = yml.replace(/:\((?:exclude,)?glob\)[^']*/g, '');
    expect(withoutGlobbed.match(bareFileGlob) ?? []).toEqual([]);
  });

  it('density SRC denominator covers scripts/**/*.js and src js/jsx (production JS counted)', () => {
    expect(yml).toContain(":(glob)scripts/**/*.js'");
    expect(yml).toContain(":(glob)src/**/*.js'");
    expect(yml).toContain(":(glob)src/**/*.jsx'");
  });
});
