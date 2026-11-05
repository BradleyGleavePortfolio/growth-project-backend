import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProbeCopy } from './ls-1185-probe-copy';
import { ANY_MODEL, scanMemberContentReads } from './member-content-scan';

const AUTHORED = `const authored = { some: { body: { contains: 'query' } } };`;

const FORMS: Array<[string, string, string]> = [
  ['class field changed by a helper',
    `${AUTHORED}
     export class UnsafeHeldReader {
       private where: Record<string, unknown> = {};
       private configure() { this.where.community_posts_authored = authored; }
       read(p: any) { this.configure(); return p.user.findMany({ where: this.where }); }
     }`, 'UnsafeHeldReader.read'],
  ['class field assigned a new held filter',
    `${AUTHORED}
     export class UnsafeHeldReader {
       private where: Record<string, unknown> = {};
       read(p: any) {
         this.where = { community_posts_authored: authored };
         return p.user.findMany({ where: this.where });
       }
     }`, 'UnsafeHeldReader.read'],
  ['an object property changed after construction',
    `${AUTHORED}
     export function unsafeHeld(p: any) {
       const holder = { where: {} as Record<string, unknown> };
       holder.where.community_posts_authored = authored;
       return p.user.findMany({ where: holder.where });
     }`, 'unsafeHeld'],
  ['Object.defineProperty adds a relation to the held where',
    `${AUTHORED}
     export function unsafeHeld(p: any) {
       const where = {};
       Object.defineProperty(where, 'community_posts_authored', { value: authored, enumerable: true });
       return p.user.findMany({ where });
     }`, 'unsafeHeld'],
  ['Object.defineProperties adds a relation to the held where',
    `${AUTHORED}
     export function unsafeHeld(p: any) {
       const where = {};
       Object.defineProperties(where, { community_posts_authored: { value: authored, enumerable: true } });
       return p.user.findMany({ where });
     }`, 'unsafeHeld'],
  ['Reflect.set adds a relation to the held where',
    `${AUTHORED}
     export function unsafeHeld(p: any) {
       const where = {};
       Reflect.set(where, 'community_posts_authored', authored);
       return p.user.findMany({ where });
     }`, 'unsafeHeld'],
  ['a local identifier mutation remains a positive control',
    `${AUTHORED}
     export function unsafeHeld(p: any) {
       const where: Record<string, unknown> = {};
       where.community_posts_authored = authored;
       return p.user.findMany({ where });
     }`, 'unsafeHeld'],
];

describe('LS-1185R6 B1: held arguments must include later writes or fail closed', () => {
  it.each(FORMS)('%s keeps the member-content read obligation', (_name, source, reader) => {
    const root = mkdtempSync(join(tmpdir(), 'ls1185r6-held-'));
    try {
      writeFileSync(join(root, 'probe.ts'), source);
      const sites = scanMemberContentReads(root).filter((s) => s.reader === reader);
      expect(sites.some((s) => s.model === 'CommunityPost' || s.model === ANY_MODEL)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an unregistered user read whose held field receives an unsafe post condition', () => {
    const root = createProbeCopy();
    const resultDir = mkdtempSync(join(tmpdir(), 'ls1185r6-held-result-'));
    try {
      writeFileSync(join(root, 'src/ls-1185r6-held-field.ts'), `
        import type { Prisma, PrismaClient } from '@prisma/client';
        const authored: Prisma.CommunityPostListRelationFilter = {
          some: { body: { contains: 'query' } },
        };
        export class UnsafeHeldReader {
          private where: Prisma.UserWhereInput = {};
          private configure() { this.where.community_posts_authored = authored; }
          read(prisma: PrismaClient) {
            this.configure();
            return prisma.user.findMany({ where: this.where });
          }
        }
      `);
      const report = join(resultDir, 'result.json');
      const run = spawnSync(process.execPath, [
        require.resolve('jest/bin/jest'), '--runInBand', '--no-cache', '--json',
        `--outputFile=${report}`, '--testNamePattern=finds no unregistered read',
        'test/community/access/member-content-access.spec.ts',
      ], { cwd: root, encoding: 'utf8', timeout: 110000, maxBuffer: 8 * 1024 * 1024 });
      if (run.error) throw run.error;
      const result = JSON.parse(readFileSync(report, 'utf8')) as { numFailedTests: number };
      console.log(`LS-1185R6 held-field gate: exit=${run.status}, failed=${result.numFailedTests}`);
      expect(result.numFailedTests).toBe(1);
      expect(run.stdout + run.stderr).toContain('UnsafeHeldReader.read');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(resultDir, { recursive: true, force: true });
    }
  }, 120000);
});
