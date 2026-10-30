import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { REPO_ROOT } from './member-content-scan';

describe('LS-1185 B2: each fixed KNOWN GAP must invalidate its registry row', () => {
  it('fixing the single-target reactions ban/departure gap makes the existing contract red', () => {
    const runtime = join(REPO_ROOT, 'src/community/reactions/community-reactions.service.ts');
    const smoke = join(__dirname, 'ls-1185-generated-gap.spec.ts');
    const scratch = mkdtempSync(join(tmpdir(), 'ls1185-gap-'));
    const report = join(scratch, 'result.json');
    const original = readFileSync(runtime, 'utf8');
    const before = 'return this.safety.filterBlocked(user.id, rows, (r) => r.user_id);';
    const after = 'return this.safety.filterBlocked(user.id, rows, (r) => r.user_id, () => [t.workspaceId, null]);';
    expect(original.includes(before)).toBe(true);
    try {
      writeFileSync(runtime, original.replace(before, after));
      writeFileSync(smoke, [
        "import { accessWorld } from './member-content-fixture';",
        "const { CommunityReactionsService } = require('../../../src/community/reactions/community-reactions.service');",
        "it.each(['banned from the community', 'departed (moved to another coach)'])('fixed real reaction reader hides %s, keeping control', async (rule: any) => {",
        '  const w = await accessWorld(); const author = w.member("Hidden Reactor");',
        '  const rows = [{user_id: author.id}, {user_id: w.control.id}];',
        '  const svc = new CommunityReactionsService(null, {listForTarget: async () => rows}, null, null, null, w.safety);',
        '  const target = {workspaceId: w.wsId, targetType: "post", targetId: w.postId};',
        '  expect(await svc.visibleReactions(w.viewer, target)).toHaveLength(2);',
        '  await w.apply(rule, author);',
        '  expect(await svc.visibleReactions(w.viewer, target)).toEqual([{user_id: w.control.id}]);',
        '});',
      ].join('\n'));
      const run = spawnSync(process.execPath, [
        require.resolve('jest/bin/jest'), '--runInBand', '--no-cache', '--json', `--outputFile=${report}`,
        'test/community/access/member-content-access.spec.ts',
        'test/community/access/ls-1185-generated-gap.spec.ts',
      ], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 110000, maxBuffer: 1024 * 1024 });
      if (run.error) throw run.error;
      const result = JSON.parse(readFileSync(report, 'utf8')) as {
        numFailedTests: number;
        numPassedTests: number;
        testResults: Array<{ name: string; status: string }>;
      };
      const smokeResult = result.testResults.find((r) => r.name.endsWith('ls-1185-generated-gap.spec.ts'));
      expect(smokeResult?.status).toBe('passed');
      console.log(`LS-1185 fixed-gap proof: ${result.numPassedTests} passed, ${result.numFailedTests} failed; real ban/departure smoke passed`);
      // The runtime gap was genuinely fixed, but its stale GAP declarations must now fail.
      expect(result.numFailedTests).toBeGreaterThan(0);
    } finally {
      writeFileSync(runtime, original);
      rmSync(smoke, { force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 120000);
});
