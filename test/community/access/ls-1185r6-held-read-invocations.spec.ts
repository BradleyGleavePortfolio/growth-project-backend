import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProbeCopy } from './ls-1185-probe-copy';
import { ANY_MODEL, scanMemberContentReads } from './member-content-scan';

const HELD = `
  const authored = { some: { body: { contains: 'query' } } };
  const where = { community_posts_authored: authored };
`;
const FORMS: Array<[string, string]> = [
  ['literal element read method',
    `${HELD} export const unsafeRead = (p: any) => p.user['findMany']({ where });`],
  ['constant element read method',
    `${HELD} const METHOD = 'findMany';
     export const unsafeRead = (p: any) => p.user[METHOD]({ where });`],
  ['destructured read method',
    `${HELD} export function unsafeRead(p: any) {
       const { findMany } = p.user;
       return findMany({ where });
     }`],
  ['read method invoked with call',
    `${HELD} export const unsafeRead = (p: any) => p.user.findMany.call(p.user, { where });`],
  ['read method invoked with apply',
    `${HELD} export const unsafeRead = (p: any) => p.user.findMany.apply(p.user, [{ where }]);`],
  ['read method invoked with bind',
    `${HELD} export function unsafeRead(p: any) {
       const list = p.user.findMany.bind(p.user);
       return list({ where });
     }`],
  ['ordinary dotted method remains a positive control',
    `${HELD} export const unsafeRead = (p: any) => p.user.findMany({ where });`],
];

describe('LS-1185R6 B2: read invocation form cannot discard held argument obligations', () => {
  it.each(FORMS)('%s is followed or fails closed', (_name, source) => {
    const root = mkdtempSync(join(tmpdir(), 'ls1185r6-invoke-'));
    try {
      writeFileSync(join(root, 'probe.ts'), source);
      const sites = scanMemberContentReads(root).filter((s) => s.reader === 'unsafeRead');
      expect(sites.some((s) => s.model === 'CommunityPost' || s.model === ANY_MODEL)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an unsafe held relation read invoked through a literal method key', () => {
    const root = createProbeCopy();
    const resultDir = mkdtempSync(join(tmpdir(), 'ls1185r6-invoke-result-'));
    try {
      writeFileSync(join(root, 'src/ls-1185r6-held-invocation.ts'), `
        import type { Prisma, PrismaClient } from '@prisma/client';
        const authored: Prisma.CommunityPostListRelationFilter = {
          some: { body: { contains: 'query' } },
        };
        const where: Prisma.UserWhereInput = { community_posts_authored: authored };
        export const unsafeHeldInvocation = (prisma: PrismaClient) =>
          prisma.user['findMany']({ where });
      `);
      const report = join(resultDir, 'result.json');
      const run = spawnSync(process.execPath, [
        require.resolve('jest/bin/jest'), '--runInBand', '--no-cache', '--json',
        `--outputFile=${report}`, '--testNamePattern=finds no unregistered read',
        'test/community/access/member-content-access.spec.ts',
      ], { cwd: root, encoding: 'utf8', timeout: 110000, maxBuffer: 8 * 1024 * 1024 });
      if (run.error) throw run.error;
      const result = JSON.parse(readFileSync(report, 'utf8')) as { numFailedTests: number };
      console.log(`LS-1185R6 held-invocation gate: exit=${run.status}, failed=${result.numFailedTests}`);
      expect(result.numFailedTests).toBe(1);
      expect(run.stdout + run.stderr).toContain('unsafeHeldInvocation');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(resultDir, { recursive: true, force: true });
    }
  }, 120000);
});
