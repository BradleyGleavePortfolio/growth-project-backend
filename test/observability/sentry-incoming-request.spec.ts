import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

it('sanitizes actual SDK-enriched incoming errors with production-order default instrumentation', () => {
  const result = spawnSync(
    process.execPath,
    [join(__dirname, 'fixtures/sentry-incoming-request.cjs')],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  const summary = JSON.parse(result.stdout.trim().split('\n').slice(-1)[0]);
  expect(summary).toEqual({
    cases: 2,
    defaultIntegrations: true,
    separateClient: true,
    localTransport: true,
    errorEventMetadataSanitized: true,
  });
});
