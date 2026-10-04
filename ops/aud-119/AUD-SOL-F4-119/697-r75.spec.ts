// Audit-only execution of the trusted range checker at the exact candidate.
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

it('R75 b644198b..88c72200 has no positive per-class token change across src and test', () => {
  const cwd = join(__dirname, '..');
  const base = 'b644198b90bb9ab1dc62a78794e12cf09f8ace7c';
  const head = '88c722003c23634df69338e4ee6ceb2dd71068e6';
  execFileSync('git', ['fetch', '--no-tags', 'origin', base, head], { cwd });
  const result = spawnSync('node', ['scripts/check-r75.js', '--mode=range', `--base=${base}`, `--head=${head}`],
    { cwd, encoding: 'utf8', timeout: 30000 });
  console.log(result.stdout, result.stderr);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('OK — no positive token change');
});
