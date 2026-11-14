/**
 * LS-1251R2 review-only runner. The changed acknowledgement RLS suite normally
 * runs outside the default Jest configuration. Provision the same disposable
 * database as the DM row-layer tests, then run the original suite unchanged.
 * This file is review evidence only; never merge the review branch.
 */
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { ls1197Database } from './ls-1197-live-fixture';

jest.setTimeout(600_000);

it('LS-1251R2: the changed live acknowledgement suite passes on the exact reviewed code', async () => {
  const db = await ls1197Database();
  try {
    execFileSync(process.execPath, [
      require.resolve('jest/bin/jest'),
      '--ci',
      '--runInBand',
      '--forceExit',
      '--config=jest.rls.config.js',
      '--runTestsByPath',
      'test/rls/community-ack-visibility-rls.spec.ts',
    ], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, TEST_DATABASE_URL: db.url, DATABASE_URL: db.url, DIRECT_URL: db.url },
      stdio: 'inherit',
      timeout: 300_000,
    });
  } finally {
    await db.stop();
  }
});
