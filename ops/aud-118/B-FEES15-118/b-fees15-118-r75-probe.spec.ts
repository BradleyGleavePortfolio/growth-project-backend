// Lane-only probe (B-FEES15-118, agent 118; never merged). Runs the repo's own R75 checker
// (scripts/check-r75.js + .github/r75-policy.json) over the two F2 test files B-682-9 touches.
// - test/s-fee-r11-reversal-admission-diagnostics.spec.ts is new in F2 (absent on main), so an
//   empty base is exactly its contribution: no banned class at all.
// - test/transfer-orchestrator.service.spec.ts exists on main b644198b with exactly 1 `as any`
//   and no other banned class; F2 may not add any.
import { execFileSync, spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const ROOT = join(__dirname, '..');

function r75(file: string): { status: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'r75-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const put = (rel: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(dir, rel));
  };
  git('init', '-q');
  git('config', 'user.email', 'lane@tgp.invalid');
  git('config', 'user.name', 'lane');
  put('.github/r75-policy.json');
  git('add', '.');
  git('commit', '-qm', 'base: policy only');
  put(file);
  git('add', '.');
  git('commit', '-qm', 'head: file');
  const r = spawnSync(
    'node',
    [join(ROOT, 'scripts/check-r75.js'), '--mode=range', '--base=HEAD~1', '--head=HEAD'],
    { cwd: dir, encoding: 'utf8' },
  );
  const out = `${r.stdout}${r.stderr}`;
  process.stdout.write(`B-FEES15-118 R75 ${file} status=${r.status}\n${out}\n`);
  return { status: r.status, out };
}

it('B-682-9: the F2 round-14 spec carries no banned R75 token', () => {
  const { status, out } = r75('test/s-fee-r11-reversal-admission-diagnostics.spec.ts');
  expect(out).toMatch(/OK — no positive token change/);
  expect(status).toBe(0);
});

it('B-682-9: the transfer orchestrator spec keeps main\'s single `as any` and adds nothing', () => {
  const { out } = r75('test/transfer-orchestrator.service.spec.ts');
  const classes = out.split('\n').filter((l) => /^[^ ].*: \+\d+ -\d+ net/.test(l));
  expect(classes).toEqual(['as any: +1 -0 net +1']);
});
