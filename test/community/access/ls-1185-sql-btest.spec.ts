import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProbeCopy } from './ls-1185-probe-copy';

describe('LS-1185 B3: actual SQL access predicates must drive the behavior result', () => {
  it('removing the community-wide ban predicate from the registered read makes the contract red', () => {
    const root = createProbeCopy();
    const runtime = join(root, 'src/community/community-space-access.ts');
    const scratch = mkdtempSync(join(tmpdir(), 'ls1185-sql-'));
    const report = join(scratch, 'result.json');
    const original = readFileSync(runtime, 'utf8');
    const predicate = '      AND app.community_author_unbanned(t."w", t."a")';
    expect(original.includes(predicate)).toBe(true);
    try {
      const mutated = original.replace(predicate, '');
      expect(mutated.includes(predicate)).toBe(false);
      writeFileSync(runtime, mutated);
      const run = spawnSync(process.execPath, [
        require.resolve('jest/bin/jest'), '--runInBand', '--no-cache', '--json', `--outputFile=${report}`,
        'test/community/access/member-content-access.spec.ts',
      ], { cwd: root, encoding: 'utf8', timeout: 110000, maxBuffer: 1024 * 1024 });
      if (run.error) throw run.error;
      const result = JSON.parse(readFileSync(report, 'utf8')) as {
        numFailedTests: number;
        numPassedTests: number;
      };
      console.log(`LS-1185 missing-ban-predicate proof: ${result.numPassedTests} passed, ${result.numFailedTests} failed`);
      expect(result.numFailedTests).toBeGreaterThan(0);
    } finally {
      writeFileSync(runtime, original);
      rmSync(scratch, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});
