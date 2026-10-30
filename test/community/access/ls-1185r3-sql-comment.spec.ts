import 'reflect-metadata';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { accessWorld } from './member-content-fixture';
import { createProbeCopy } from './ls-1185-probe-copy';

describe('LS-1185R3 B3: a commented-out SQL predicate is not an applied rule', () => {
  it.each(['block', 'line'])('%s-commented ban predicate keeps the banned author in the raw result', async (style) => {
    const w = await accessWorld();
    const a = w.member('Banned Stayer');
    w.db.seed('communityWorkspaceBan', { workspace_id: w.wsId, user_id: a.id, lifted_at: null });
    const comment = style === 'block'
      ? '/* AND app.community_author_unbanned(t."w", t."a") */'
      : '-- AND app.community_author_unbanned(t."w", t."a")\n';
    const parts = [
      'SELECT (t."n" - 1)::int AS "n" FROM unnest(',
      '::uuid[], ',
      '::text[], ',
      '::text[]) WITH ORDINALITY AS t("w", "s", "a", "n") WHERE TRUE ' + comment,
    ];
    const query = Object.assign(parts, { raw: parts });
    expect(await w.db.$queryRaw(query, [w.wsId], [w.cohortId], [a.id])).toEqual([{ n: 0 }]);
  });

  it('the active ban predicate still drops the banned author (positive control)', async () => {
    const w = await accessWorld();
    const a = w.member('Banned Stayer');
    w.db.seed('communityWorkspaceBan', { workspace_id: w.wsId, user_id: a.id, lifted_at: null });
    expect(await w.db.$queryRaw`
      SELECT (t."n" - 1)::int AS "n"
      FROM unnest(${[w.wsId]}::uuid[], ${[w.cohortId]}::text[], ${[a.id]}::text[]) WITH ORDINALITY AS t("w", "s", "a", "n")
      WHERE app.community_author_unbanned(t."w", t."a")`).toEqual([]);
  });

  it('commenting out only the real ban predicate must turn the original contract red', () => {
    const root = createProbeCopy();
    const runtime = join(root, 'src/community/community-space-access.ts');
    const report = join(root, 'ls1185r3-comment-result.json');
    const original = readFileSync(runtime, 'utf8');
    const predicate = '      AND app.community_author_unbanned(t."w", t."a")';
    expect(original).toContain(predicate);
    writeFileSync(runtime, original.replace(predicate, `      /* ${predicate.trim()} */`));
    try {
      const run = spawnSync(process.execPath, [
        require.resolve('jest/bin/jest'), '--runInBand', '--no-cache', '--json', `--outputFile=${report}`,
        'test/community/access/member-content-access.spec.ts',
      ], { cwd: root, encoding: 'utf8', timeout: 110000, maxBuffer: 1024 * 1024 });
      if (run.error) throw run.error;
      const result = JSON.parse(readFileSync(report, 'utf8')) as { numFailedTests: number; numPassedTests: number };
      console.log(`LS-1185R3 commented-ban proof: ${result.numPassedTests} original cases passed, ${result.numFailedTests} failed`);
      expect(result.numFailedTests).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});
