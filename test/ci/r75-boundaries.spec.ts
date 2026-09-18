// Adversarial boundary tests run the shipped checker against real Git objects.
// Inputs stay in JSON data; this executable test remains inside the scan scope.
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

interface TokenVector {
  name: string;
  input: string;
}
interface BoundaryData {
  tokens: TokenVector[];
  trivia: TokenVector[];
  reasons: { input: string; exit: number }[];
  authoredPaths: string[];
  outsidePaths: string[];
  linkPaths: string[];
  emptyHeads: string[];
}
type Mode = 'range' | 'staged';
const root = join(__dirname, '../..');
const checker = join(root, 'scripts/check-r75.js');
const policyPath = '.github/r75-policy.json';
const policy = readFileSync(join(root, policyPath), 'utf8');
const vectors: BoundaryData = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/r75-boundaries.json'), 'utf8'),
);
const directories: string[] = [];
// Ignore ambient Git repository/index/config overrides. No host hook or signing
// configuration should execute in a synthetic repository.
const environment = {
  PATH: process.env.PATH,
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

function processResult(repo: string, binary: string, args: string[]) {
  const result = spawnSync(binary, args, {
    cwd: repo,
    env: environment,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    killSignal: 'SIGKILL',
  });
  if (result.error || result.signal || result.status === null) {
    throw result.error ?? new Error(`harness process interrupted: ${result.signal}`);
  }
  return result;
}

function git(repo: string, ...args: string[]): string {
  const result = processResult(repo, 'git', args);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function write(repo: string, path: string, input: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), input);
}

function repository(): string {
  const repo = mkdtempSync(join(tmpdir(), 'r75-boundary-'));
  directories.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@invalid.local');
  write(repo, policyPath, policy);
  git(repo, 'add', '-A', '-f');
  git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base');
  return repo;
}

function run(repo: string, mode: Mode, extra: string[] = []) {
  const args = mode === 'range' ? ['--mode=range', '--base=HEAD~1'] : ['--mode=staged'];
  return processResult(repo, process.execPath, [checker, ...args, ...extra]);
}

function stage(repo: string, mode: Mode): void {
  git(repo, 'add', '-A', '-f');
  if (mode === 'range') {
    git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'head');
  }
}

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe.each<Mode>(['range', 'staged'])('R75 lexical and path boundaries: %s', (mode) => {
  it.each([...vectors.tokens, ...vectors.trivia])('counts $name in $input', (vector) => {
    const repo = repository();
    write(repo, 'src/example.ts', vector.input);
    stage(repo, mode);
    const result = run(repo, mode);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${vector.name}: +1 -0 net +1`);
    expect(result.stdout).toContain('src/example.ts');
    expect(result.stderr).toBe('');
  });

  it.each(vectors.reasons)('bounds a directive reason: $input', (vector) => {
    const repo = repository();
    write(repo, 'src/example.ts', vector.input);
    stage(repo, mode);
    const result = run(repo, mode);
    expect(result.status).toBe(vector.exit);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(vector.exit ? 'FAIL:' : 'OK');
  });

  it.each(vectors.authoredPaths)('does not infer generated provenance from %s', (path) => {
    const repo = repository();
    write(repo, path, vectors.tokens[0].input);
    stage(repo, mode);
    const result = run(repo, mode);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(path);
    expect(result.stdout).toContain(`${vectors.tokens[0].name}: +1 -0 net +1`);
  });

  it.each(vectors.outsidePaths)('retains the positive-root boundary for %s', (path) => {
    const repo = repository();
    write(repo, path, vectors.tokens[0].input);
    stage(repo, mode);
    const result = run(repo, mode);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
    expect(result.stdout).not.toContain(path);
  });

  it.each(vectors.linkPaths)('fails closed on an authored symlink at %s', (path) => {
    const repo = repository();
    write(repo, 'outside.ts', vectors.tokens[0].input);
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    symlinkSync('../outside.ts', join(repo, path));
    stage(repo, mode);
    const result = run(repo, mode);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unsupported source mode');
    expect(result.stdout).not.toContain('OK');
  });
});

describe('R75 explicit committed-head contract', () => {
  it.each(vectors.emptyHeads)('rejects an explicitly empty head: %s', (head) => {
    const repo = repository();
    stage(repo, 'range');
    const result = run(repo, 'range', [head]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('nonempty head');
    expect(result.stdout).not.toContain('OK');
  });

  it('still permits an omitted head to select HEAD', () => {
    const repo = repository();
    write(repo, 'src/example.ts', 'export const value = 1;');
    stage(repo, 'range');
    const result = run(repo, 'range');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK');
    expect(result.stderr).toBe('');
  });

  it('declares every canonical class independently of policy membership', () => {
    const names = JSON.parse(policy).tokens.map((token: { name: string }) => token.name);
    expect(names.sort()).toEqual(vectors.tokens.map((token) => token.name).sort());
    expect(new Set(names).size).toBe(12);
  });
});
