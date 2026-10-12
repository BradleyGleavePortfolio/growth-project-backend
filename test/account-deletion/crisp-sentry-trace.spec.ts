import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// B-918-2: deleting an account must not attach the Crisp email to a Sentry performance report.
it('keeps the Crisp email out of real SDK transaction envelopes', () => {
  const fixture = join(__dirname, 'fixtures/crisp-sentry-trace.cjs');
  const result = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 30_000 });
  expect({ error: result.error?.message, status: result.status, stderr: result.stderr }).toEqual({
    error: undefined,
    status: 0,
    stderr: '',
  });
}, 35_000);
