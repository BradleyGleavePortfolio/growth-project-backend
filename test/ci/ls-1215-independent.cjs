// Independent LS-1215 probes. Run directly with node --test; no dependencies.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join, dirname } = require('node:path');
const root = resolve(__dirname, '../..');
const checker = join(root, 'scripts/check-r75.js');
const path = '.github/r75-policy.json';
const policy = readFileSync(join(root, path), 'utf8');
const vector = JSON.parse(readFileSync(join(root, 'test/ci/fixtures/r75-boundaries.json'), 'utf8')).tokens[0];
const weak = JSON.stringify({
  scan: { ...JSON.parse(policy).scan, includeRoots: ['irrelevant/'] },
  tokens: [{ name: 'independent-unmatched', pattern: 'independent-unmatched' }],
});
const workflow = readFileSync(join(root, '.github/workflows/r100-quality-gate.yml'), 'utf8');
const body = workflow.split('        run: |\n')[1].split('\n').map((line) => line.slice(10)).join('\n');
const dirs = [];
const environment = {
  PATH: process.env.PATH,
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
function command(repo, binary, args, extra = {}) {
  const result = spawnSync(binary, args, {
    cwd: repo, env: { ...environment, ...extra }, encoding: 'utf8',
    timeout: 10000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.signal) throw result.error || new Error(result.signal);
  return result;
}
function git(repo, ...args) {
  const result = command(repo, 'git', args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function write(repo, file, value) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), value);
}
function commit(repo, message) {
  git(repo, 'add', '-Af');
  git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', message);
  return git(repo, 'rev-parse', 'HEAD');
}
function fixture({ headPolicy = weak, basePolicy = policy, remoteName = 'main', omitBasePolicy = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'ls1215-independent-'));
  dirs.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Independent fixture');
  git(repo, 'config', 'user.email', 'fixture@invalid.local');
  write(repo, 'scripts/check-r75.js', readFileSync(checker, 'utf8'));
  write(repo, path, weak);
  const ancestor = commit(repo, 'old fork with weak policy');
  git(repo, 'checkout', '-qb', 'hostile-policy-change');
  write(repo, 'src/probe.ts', vector.input);
  write(repo, path, headPolicy);
  const head = commit(repo, 'PR edits policy and adds prohibited token');
  git(repo, 'checkout', '-q', '--detach', ancestor);
  if (omitBasePolicy) git(repo, 'rm', '-q', path);
  else write(repo, path, basePolicy);
  write(repo, 'base-note.txt', 'base branch advances independently');
  const base = commit(repo, 'base policy advances');
  git(repo, 'update-ref', `refs/remotes/origin/${remoteName}`, base);
  git(repo, 'checkout', '-q', '--detach', head);
  return { repo, ancestor, head, base, remoteName };
}
function range(f, options = {}) {
  return command(f.repo, process.execPath, [
    checker, '--mode=range', `--base=${f.ancestor}`, `--head=${f.head}`,
    ...Object.entries(options).map(([key, value]) => `--${key}=${value}`),
  ]);
}
function wired(f, env = {}) {
  return command(f.repo, 'bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', body], {
    EVENT_NAME: 'pull_request', BASE_SHA: f.ancestor, HEAD_SHA: f.head,
    BASE_REF: f.remoteName, ...env,
  });
}
function failure(result, status) {
  assert.equal(result.status, status, JSON.stringify(result));
  assert.doesNotMatch(result.stdout, /OK —/);
}
after(() => { for (const repo of dirs) rmSync(repo, { recursive: true, force: true }); });

test('policy-changing branch cannot self-exempt; old-head control really passes', () => {
  const f = fixture();
  const control = range(f);
  assert.equal(control.status, 0, control.stderr);
  assert.match(control.stdout, /OK —/);
  const repaired = range(f, { 'policy-base': f.base });
  failure(repaired, 1);
  assert.match(repaired.stdout, /FAIL: positive per-class/);
  assert.match(repaired.stdout, /note: this change edits/);
  assert.match(repaired.stdout, new RegExp(`policy from base ${f.base}`));
});

test('actual workflow reads remote base, not weaker fork or PR policy', () => {
  const f = fixture();
  const result = wired(f);
  failure(result, 1);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, new RegExp(`policy from base ${f.base}`));
});

test('checkout clean base cannot mask event-head violation', () => {
  const f = fixture({ headPolicy: policy });
  git(f.repo, 'checkout', '-q', '--detach', f.base);
  failure(wired(f), 1);
});

test('non-main base branch with slash uses its own fetched policy', () => {
  const f = fixture({ remoteName: 'release/r75' });
  failure(wired(f), 1);
  failure(wired(f, { BASE_REF: 'main' }), 1);
});

test('deleted and unfetched remote base refs fail closed, not old-policy fallback', () => {
  const f = fixture();
  git(f.repo, 'update-ref', '-d', 'refs/remotes/origin/main');
  for (const name of ['main', '', 'not-fetched', '   ', 'main; echo injected']) {
    const result = wired(f, { BASE_REF: name });
    failure(result, 1);
    assert.match(result.stderr, /base branch/);
  }
});

test('blank malformed and absent policy refs fail operationally', () => {
  const f = fixture();
  for (const value of ['', '   ', 'not-a-commit', '--help']) {
    const result = range(f, { 'policy-base': value });
    failure(result, 2);
    assert.match(result.stderr, /operational failure/);
  }
});

test('unusable base policies never fall back to usable PR policy', () => {
  for (const basePolicy of ['{bad json', '{}', '[]']) {
    const f = fixture({ headPolicy: policy, basePolicy });
    const result = wired(f);
    failure(result, 2);
    assert.match(result.stderr, /operational failure/);
  }
  const absent = fixture({ headPolicy: policy, omitBasePolicy: true });
  failure(wired(absent), 2);
});

test('working tree policy tampering cannot affect trusted range or index behavior', () => {
  const f = fixture({ headPolicy: policy });
  write(f.repo, path, weak);
  failure(range(f, { 'policy-base': f.base }), 1);
  write(f.repo, 'src/staged.ts', vector.input);
  git(f.repo, 'add', '-f', 'src/staged.ts');
  const staged = command(f.repo, process.execPath, [checker, '--mode=staged']);
  failure(staged, 1);
  assert.match(staged.stdout, /index tree/);
});

test('staged mode rejects policy-base rather than pretending to certify it', () => {
  const f = fixture();
  const result = command(f.repo, process.execPath, [checker, '--mode=staged', `--policy-base=${f.base}`]);
  failure(result, 2);
  assert.match(result.stderr, /only valid with --mode=range/);
});

test('base advance before resolution is honored; after resolution immutable SHA is used', () => {
  const f = fixture();
  const original = f.base;
  git(f.repo, 'checkout', '-q', '--detach', f.base);
  write(f.repo, path, weak);
  const advanced = commit(f.repo, 'later accepted weak policy');
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', advanced);
  assert.equal(wired(f).status, 0);
  failure(range(f, { 'policy-base': original }), 1);
});
