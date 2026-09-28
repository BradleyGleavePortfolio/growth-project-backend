import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');
const script = join(repoRoot, 'scripts', 'env-gap-report.mjs');
const fixtures = join(__dirname, 'fixtures', 'env-gap-report');

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('env-gap-report', () => {
  it('reports SET / EMPTY / MISSING without printing local env values', () => {
    const result = run('--env', join(fixtures, 'local.env'));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('DATABASE_URL');
    expect(result.stdout).toMatch(/DATABASE_URL\s+hard\s+SET/);
    expect(result.stdout).toMatch(/DIRECT_URL\s+hard\s+EMPTY/);
    expect(result.stdout).toMatch(/ANTHROPIC_API_KEY\s+optional\s+EMPTY/);
    expect(result.stdout).toContain('enabled flag dependency');
    expect(result.stdout).not.toContain('fixture-do-not-print-database-value');
    expect(result.stdout).not.toContain('fixture-do-not-print-supabase-url');
    expect(result.stdout).not.toContain('fixture-do-not-print-service-role');
    expect(result.stdout).not.toContain('fixture-do-not-print-usda-key');
  });

  it('accepts the names-only Fly secrets-list format without inventing values', () => {
    const result = run('--names', join(fixtures, 'fly-secrets-list.txt'));

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/DATABASE_URL\s+hard\s+SET/);
    expect(result.stdout).toMatch(/ANTHROPIC_API_KEY\s+optional\s+SET/);
    expect(result.stdout).toMatch(/DIRECT_URL\s+hard\s+MISSING/);
    expect(result.stdout).not.toContain('sha256:example');
  });

  it('generates a checked-in empty inventory with ANTHROPIC_API_KEY first', () => {
    execFileSync(process.execPath, [script, '--write-docs'], { cwd: repoRoot });
    const doc = readFileSync(join(repoRoot, 'docs/ops/KEYS_NEEDED.md'), 'utf8');
    const firstRow = doc.split('\n').find((line) => line.startsWith('| `'));

    expect(firstRow).toContain('`ANTHROPIC_API_KEY`');
    expect(doc).toContain('Values are never printed in report output.');
    expect(run('--check-docs').status).toBe(0);
  });
});
