/**
 * LS-1185R4 B2 B-TEST: `_count: true` reads all relations whether the include/select is inline, held, spread,
 * or returned by a helper. These are the same held-argument forms the shared scan already follows for named
 * relations. Every unregistered form must turn the real architecture gate red. Test-only; no runtime changes.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ANY_MODEL, scanMemberContentReads } from './member-content-scan';
import { createProbeCopy } from './ls-1185-probe-copy';

const forms: Array<[string, string]> = [
  ['control: inline select', 'export const preview = (prisma: any) => prisma.communityCohort.findMany({select: {id: true, _count: true}});'],
  ['select held in a constant', 'const SELECT = {id: true, _count: true}; export const preview = (prisma: any) => prisma.communityCohort.findMany({select: SELECT});'],
  ['include held in a constant', 'const INCLUDE = {_count: true}; export const preview = (prisma: any) => prisma.communityCohort.findMany({include: INCLUDE});'],
  ['select spread from a constant', 'const BASE = {_count: true}; export const preview = (prisma: any) => prisma.communityCohort.findMany({select: {id: true, ...BASE}});'],
  ['select returned by a helper', 'const selection = () => ({id: true, _count: true}); export const preview = (prisma: any) => prisma.communityCohort.findMany({select: selection()});'],
];

describe('LS-1185R4 B2: unnamed relation counts stay reads through held include/select arguments', () => {
  it.each(forms)('%s', (_name, source) => {
    const root = mkdtempSync(join(tmpdir(), 'ls1185r4-count-'));
    try {
      writeFileSync(join(root, 'preview.ts'), source);
      expect(scanMemberContentReads(root).filter((s) => s.reader === 'preview').map((s) => s.model)).toContain(ANY_MODEL);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([forms[0], forms[1]])('real architecture gate rejects an unregistered %s', (_name, source) => {
    const root = createProbeCopy();
    const report = join(root, 'ls1185r4-count-result.json');
    try {
      writeFileSync(join(root, 'src/community/access-count-preview.ts'), source);
      const run = spawnSync(process.execPath, [
        require.resolve('jest/bin/jest'), '--runInBand', '--no-cache', '--json', `--outputFile=${report}`,
        '--testNamePattern=finds no unregistered read',
        'test/community/access/member-content-access.spec.ts',
      ], { cwd: root, encoding: 'utf8', timeout: 110000, maxBuffer: 1024 * 1024 });
      if (run.error) throw run.error;
      const result = JSON.parse(readFileSync(report, 'utf8')) as { numFailedTests: number; numPassedTests: number };
      console.log(`LS-1185R4 count gate: ${_name}: ${result.numPassedTests} passed, ${result.numFailedTests} failed`);
      expect(result.numPassedTests + result.numFailedTests).toBe(1);
      expect(result.numFailedTests).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});
