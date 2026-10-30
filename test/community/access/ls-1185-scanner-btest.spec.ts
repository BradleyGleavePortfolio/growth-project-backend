import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { scanMemberContentReads } from './member-content-scan';

describe('LS-1185 B1: equivalent member-content reads must be discovered', () => {
  it('discovers the existing generic exports in src/data-export/data-export.service.ts', () => {
    const models = scanMemberContentReads()
      .filter((hit) => hit.file === 'src/data-export/data-export.service.ts')
      .map((hit) => hit.model);
    expect(models).toEqual(expect.arrayContaining([
      'CommunityWin', 'CommunityPost', 'CommunityMessage', 'CommunityResponse',
    ]));
  });
  const cases: Array<[string, string]> = [
    ['direct positive control', 'export const read = (prisma: any) => prisma.communityMessage.findMany({});'],
    ['delegate alias positive control', 'export const read = (prisma: any) => { const rows = prisma.communityMessage; return rows.findMany({}); };'],
    ['bound method positive control', 'export const read = (prisma: any) => { const list = prisma.communityMessage.findMany.bind(prisma.communityMessage); return list({}); };'],
    ['helper one level down positive control', 'function helper(prisma: any) { return prisma.communityMessage.findMany({}); } export const read = helper;'],
    ['raw SQL positive control', 'export const read = (prisma: any) => prisma.$queryRaw`SELECT * FROM "community_messages"`;'],
    ['literal element access', 'export const read = (prisma: any) => prisma["communityMessage"].findMany({});'],
    ['constant element access', 'const model = "communityMessage"; export const read = (prisma: any) => prisma[model].findMany({});'],
    ['destructured delegate', 'export const read = (prisma: any) => { const { communityMessage: rows } = prisma; return rows.findMany({}); };'],
    ['quoted SQL schema', 'export const read = (prisma: any) => prisma.$queryRaw`SELECT * FROM "public"."community_messages"`;'],
    ['dynamic relation include', 'const field = "community_messages_sent"; export const read = (prisma: any) => prisma.user.findMany({ include: { [field]: true } });'],
  ];

  it.each(cases)('%s identifies the fixture file and model', (_name, source) => {
    const dir = mkdtempSync(join(tmpdir(), 'ls1185-scan-'));
    const file = join(dir, 'ordinary-read.ts');
    try {
      writeFileSync(file, source);
      const hits = scanMemberContentReads(dir);
      expect(hits.map((hit) => [hit.file.endsWith('/ordinary-read.ts'), hit.model])).toContainEqual([
        true,
        'CommunityMessage',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
