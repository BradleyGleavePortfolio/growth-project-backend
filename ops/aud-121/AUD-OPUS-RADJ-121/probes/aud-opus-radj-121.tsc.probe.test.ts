// AUD-OPUS-RADJ-121 probe (Claude Opus 5.5 lens, agent 121): `tsc --noEmit` and eslint for the files of mobile#337, run inside
// the lane's single jest step (the PR's own CI never reached them: guard:vendors failed on the committed node_modules link).
import { execSync } from 'child_process';

jest.setTimeout(20 * 60_000);

const PR_FILES = [
  'src/api/romanAdjustApi.ts',
  'src/components/roman/adjust/RomanAdjustmentCard.tsx',
  'src/components/roman/adjust/RomanAdjustmentsSection.tsx',
  'src/components/roman/adjust/__tests__/RomanAdjustmentCard.test.tsx',
  'src/components/roman/adjust/romanAdjustCopy.ts',
  'src/screens/coach/command-center/ActionQueueScreen.tsx',
];

function run(cmd: string): string {
  try {
    execSync(cmd, { encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
    return '';
  } catch (e: unknown) {
    const x = e as { stdout?: string; stderr?: string };
    return `${x.stdout ?? ''}${x.stderr ?? ''}`;
  }
}

it('tsc --noEmit: no type errors in the files of this PR', () => {
  const errors = run('npx tsc --noEmit').split('\n').filter((l) => /error TS\d+/.test(l));
  // eslint-disable-next-line no-console
  console.log(`tsc errors total=${errors.length}\n${errors.slice(0, 60).join('\n')}`);
  expect(errors.filter((l) => PR_FILES.some((f) => l.includes(f)))).toEqual([]);
});

it('eslint: no lint errors in the files of this PR', () => {
  const out = run(`npx eslint --max-warnings=99999 ${PR_FILES.join(' ')}`);
  // eslint-disable-next-line no-console
  console.log(`eslint output:\n${out.slice(0, 6000)}`);
  expect(out).not.toMatch(/\(([1-9]\d*) errors?,/);
});
