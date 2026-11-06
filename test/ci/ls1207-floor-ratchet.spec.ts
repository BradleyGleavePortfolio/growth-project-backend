/**
 * LS-1207 B1: the score promises a floor that can only rise.
 * Review-only integration probe. Run on the ordinary CI lane runner, which has
 * Docker and psql; no product, workflow, account, or real key changes.
 *
 * The original suite must pass before the mutation. The same suite must then
 * refuse a floor below the approved 73, even though current search still scores
 * 73. On the reviewed head both runs pass, so this regression test fails.
 */
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const root = join(__dirname, '..', '..');
const floorFile = join(root, 'test', 'food-score', 'floor.json');

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 480_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

it('rejects lowering the saved floor below the approved 73', async () => {
  const container = `ls1207-${randomUUID()}`;
  const port = '55432';
  const original = readFileSync(floorFile, 'utf8');
  const env = {
    ...process.env,
    RLS_ADMIN_DATABASE_URL: `postgresql://postgres:postgres@localhost:${port}/postgres`,
    TEST_DATABASE_URL: `postgresql://postgres:postgres@localhost:${port}/rls_replay`,
    USDA_API_KEY: 'ls1207-synthetic-only',
    CI: 'true',
  };
  try {
    const start = run('docker', [
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=postgres', '-p', `${port}:5432`, 'postgres:15',
    ]);
    expect(start.status).toBe(0);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (run('docker', ['exec', container, 'pg_isready', '-U', 'postgres']).status === 0) {
        ready = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    expect(ready).toBe(true);
    const replay = run('bash', ['scripts/ci/replay-migrations.sh', 'rls_replay'], env);
    expect({ status: replay.status, tail: replay.stderr.slice(-2000) }).toEqual({ status: 0, tail: expect.any(String) });
    const args = [
      'jest', '--config', 'jest.rls.config.js', 'test/rls/food-score.spec.ts',
      '--runInBand', '--forceExit',
    ];
    const baseline = run('npx', args, env);
    process.stdout.write(`\nLS-1207 baseline status ${baseline.status}\n${baseline.stdout}\n`);
    expect({ status: baseline.status, tail: baseline.stderr.slice(-2000) }).toEqual({ status: 0, tail: expect.any(String) });
    expect(baseline.stdout).toContain('Food score: 73 of 92 v1 rows');
    const lowered = { ...JSON.parse(original), v1_floor: 72 };
    writeFileSync(floorFile, `${JSON.stringify(lowered, null, 1)}\n`);
    const mutated = run('npx', args, env);
    process.stdout.write(`\nLS-1207 lowered-floor status ${mutated.status}\n${mutated.stdout}\n`);
    expect(mutated.stdout).toContain('floor (v1): 72');
    expect(mutated.status).not.toBe(0);
  } finally {
    writeFileSync(floorFile, original);
    run('docker', ['rm', '-f', container]);
  }
}, 900_000);
