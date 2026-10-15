import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';

const ROOT = resolve(__dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/ci/migration-order.js');
const OLDEST = '20270401000000_old';
const NEWEST = '20270428000000_main';
const ABOVE = '20270502001800_new';
let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function migration(name: string): void {
  const dir = join(repo, 'prisma/migrations', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'migration.sql'), '-- Empty test migration.\n');
}

function commit(): void {
  git('add', '.');
  git('commit', '-m', `ci: migration fixture on ${git('branch', '--show-current')}`);
}

function run() {
  return spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf8' });
}

function expectFailure(dir: string, reason: string): void {
  const result = run();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(dir);
  expect(result.stderr).toContain(reason);
  expect(result.stderr).toContain(`main's newest is ${NEWEST}`);
  expect(result.stderr).toContain(`rename it above ${NEWEST}`);
}

function historicalGroup(): void {
  git('checkout', 'main');
  migration('20270401000000_historical');
  commit();
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', 'feature');
  git('merge', 'main', '--no-edit');
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'migration-order-'));
  git('init', '-b', 'main');
  git('config', 'user.name', 'Migration fixture');
  git('config', 'user.email', 'migration-fixture');
  git('config', 'core.hooksPath', '/dev/null');
  git('config', 'commit.gpgsign', 'false');
  migration(OLDEST);
  commit();
  git('checkout', '-b', 'feature');
  git('checkout', 'main');
  migration(NEWEST);
  commit();
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', 'feature');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('migration-order CLI (real Git fixtures, no database)', () => {
  it('passes above newest even when main advanced after the PR forked', () => {
    migration(ABOVE);
    commit();
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`new directories: ${ABOVE}`);
    expect(result.stdout).toContain('all new migrations sort above main');
  });

  it('fails equal to main newest', () => {
    migration(NEWEST);
    commit();
    expectFailure(NEWEST, 'sorts at or below main');
  });

  it('fails below main newest (the negative CI probe)', () => {
    const probe = '20270101000000_guard_probe';
    migration(probe);
    commit();
    expectFailure(probe, 'sorts at or below main');
  });

  it('fails two new directories with the same timestamp prefix', () => {
    migration(ABOVE);
    migration('20270502001800_other');
    commit();
    expectFailure('20270502001800_other', `shares timestamp prefix 20270502001800 with ${ABOVE}`);
  });

  it('passes without new migrations, including loose SQL and new files in an old directory', () => {
    writeFileSync(join(repo, 'prisma/migrations/loose.sql'), '-- Not a migration directory.\n');
    writeFileSync(join(repo, 'prisma/migrations', OLDEST, 'down.sql'), '-- Added to existing directory.\n');
    commit();
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('new directories: (none)');
    expect(result.stdout).toContain('no new migrations');
  });

  it('checks duplicate prefixes anywhere in the tree even with no new directory', () => {
    git('checkout', 'main');
    migration('20270401000000_duplicate');
    commit();
    git('branch', 'tree-with-duplicate');
    git('rm', '-r', 'prisma/migrations/20270401000000_duplicate');
    commit();
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', 'tree-with-duplicate');
    expect(run().stdout).toContain('new directories: (none)');
    expectFailure(OLDEST, 'shares timestamp prefix 20270401000000 with 20270401000000_duplicate');
  });

  it('passes an unchanged historical duplicate group already on main', () => {
    historicalGroup();
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('new directories: (none)');
    expect(result.stderr).toBe('');
  });

  it('fails a new member of a historical duplicate group', () => {
    historicalGroup();
    const dir = '20270401000000_z_new_member';
    migration(dir);
    commit();
    expectFailure(dir, 'shares timestamp prefix 20270401000000');
  });

  it('fails a new duplicate group while historical groups remain unchanged', () => {
    historicalGroup();
    migration(ABOVE);
    migration('20270502001800_other');
    commit();
    expectFailure('20270502001800_other', `shares timestamp prefix 20270502001800 with ${ABOVE}`);
  });

  it('fails a prefix that only collides with newly advanced main, despite sorting above it', () => {
    const dir = '20270428000000_z';
    migration(dir);
    commit();
    expectFailure(dir, `shares timestamp prefix 20270428000000 with ${NEWEST}`);
  });

  it('checks inherited migrations on stacked PRs against main, not their PR base', () => {
    migration('20270415000000_parent');
    commit();
    git('checkout', '-b', 'stacked-child');
    writeFileSync(join(repo, 'child.txt'), 'No migration in this child commit.\n');
    commit();
    expectFailure('20270415000000_parent', 'sorts at or below main');
  });

  it('treats renamed migration destinations as added directories', () => {
    git('mv', `prisma/migrations/${OLDEST}`, 'prisma/migrations/20270301000000_renamed');
    commit();
    expectFailure('20270301000000_renamed', 'sorts at or below main');
  });

  it('fails closed when origin/main was not fetched', () => {
    git('update-ref', '-d', 'refs/remotes/origin/main');
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unable to check migrations');
  });
});

it('wires one database-free PR job for all bases, with the actual PR head and fetched main', () => {
  const workflow = load(readFileSync(join(ROOT, '.github/workflows/migration-order.yml'), 'utf8')) as {
    on: { pull_request: unknown };
    permissions: Record<string, string>;
    jobs: Record<string, {
      services?: unknown;
      steps: Array<{ uses?: string; with?: Record<string, unknown>; run?: string }>;
    }>;
  };
  expect(workflow.on).toEqual({ pull_request: null });
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(Object.keys(workflow.jobs)).toEqual(['migration-order']);
  const job = workflow.jobs['migration-order'];
  expect(job.services).toBeUndefined();
  expect(job.steps[0].with).toEqual({
    ref: '${{ github.event.pull_request.head.sha }}',
    'fetch-depth': 0,
    'persist-credentials': false,
  });
  expect(job.steps.flatMap((step) => step.run || []).join('\n')).toBe(
    'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main\n' +
    'node scripts/ci/migration-order.js\n',
  );
});
