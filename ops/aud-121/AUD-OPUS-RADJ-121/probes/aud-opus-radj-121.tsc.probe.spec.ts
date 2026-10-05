// AUD-OPUS-RADJ-121 probe (Claude Opus 5.5 lens, agent 121): full `tsc --noEmit` on #655 @ bf9120c1 + origin/main,
// run inside the lane's single jest step so the behavioural probes are not skipped when tsc is red. Never merge.
import { execSync } from 'child_process';

jest.setTimeout(20 * 60_000);

it('tsc --noEmit: no type errors in files this PR adds or changes (B-655-1 proof when red)', () => {
  let out = '';
  try {
    execSync('npx tsc --noEmit -p tsconfig.json', {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e: unknown) {
    const x = e as { stdout?: string; stderr?: string };
    out = `${x.stdout ?? ''}${x.stderr ?? ''}`;
  }
  const errors = out.split('\n').filter((l) => /error TS\d+/.test(l));
  // eslint-disable-next-line no-console
  console.log(`tsc errors total=${errors.length}\n${errors.slice(0, 60).join('\n')}`);
  expect(errors.filter((l) => /roman-adjust|workout-builder/.test(l))).toEqual([]);
});
