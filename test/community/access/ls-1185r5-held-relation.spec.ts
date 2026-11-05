import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProbeCopy } from './ls-1185-probe-copy';
import { scanMemberContentReads } from './member-content-scan';

describe('LS-1185R5: relation filters preserve read obligations when factored', () => {
  const forms: Array<[string, string, string]> = [
    ['inline some control', 'export const read = (p: any) => p.user.findMany({ where: { community_posts_authored: { some: { body: { contains: "query" } } } } });', 'CommunityPost'],
    ['held some filter in an inline where control', 'const filter = { some: { body: { contains: "query" } } }; export const read = (p: any) => p.user.findMany({ where: { community_posts_authored: filter } });', 'CommunityPost'],
    ['held some filter in a held where', 'const filter = { some: { body: { contains: "query" } } }; const where = { community_posts_authored: filter }; export const read = (p: any) => p.user.findMany({ where });', 'CommunityPost'],
    ['held none filter in a held where', 'const filter = { none: { deleted_at: null } }; const where = { community_posts_authored: filter }; export const read = (p: any) => p.user.findMany({ where });', 'CommunityPost'],
    ['held every filter in a held where', 'const filter = { every: { deleted_at: null } }; const where = { community_posts_authored: filter }; export const read = (p: any) => p.user.findMany({ where });', 'CommunityPost'],
    ['held is filter in a held where', 'const filter = { is: { read_at: null } }; const where = { message: filter }; export const read = (p: any) => p.coachBroadcastDelivery.count({ where });', 'CoachMessage'],
    ['held isNot filter in a held where', 'const filter = { isNot: { read_at: null } }; const where = { message: filter }; export const read = (p: any) => p.coachBroadcastDelivery.count({ where });', 'CoachMessage'],
    ['post preview', 'export const read = (p: any) => p.communityPost.findMany({});', 'CommunityPost'],
    ['comment list', 'export const read = (p: any) => p.communityMessage.findMany({ where: { post_id: "p" } });', 'CommunityMessage'],
    ['thread count', 'export const read = (p: any) => p.communityMessage.count({ where: { parent_id: "p" } });', 'CommunityMessage'],
    ['search', 'export const read = (p: any) => p.communitySearchEntry.findMany({});', 'CommunitySearchEntry'],
    ['feed', 'export const read = (p: any) => p.communityWin.findMany({});', 'CommunityWin'],
    ['notification digest', 'export const read = (p: any) => p.coachMessage.groupBy({ by: ["sender_id"], _count: true });', 'CoachMessage'],
  ];
  it.each(forms)('%s is a read site', (_name, source, model) => {
    const root = mkdtempSync(join(tmpdir(), 'ls1185r5-rel-'));
    try {
      writeFileSync(join(root, 'probe.ts'), source);
      expect(scanMemberContentReads(root).map((site) => site.model)).toContain(model);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('a held scalar filter remains quiet', () => {
    const root = mkdtempSync(join(tmpdir(), 'ls1185r5-control-'));
    try {
      writeFileSync(join(root, 'probe.ts'), 'const filter = { contains: "query" }; const where = { full_name: filter }; export const read = (p: any) => p.user.findMany({ where });');
      expect(scanMemberContentReads(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('LS-1185R5: architecture-gate mutation controls', () => {
  function gate(root: string) {
    return spawnSync(process.execPath, ['node_modules/jest/bin/jest.js',
      '--runInBand', '--no-coverage', '--runTestsByPath',
      'test/community/access/member-content-access.spec.ts',
      '-t', 'finds no unregistered read'], {
      cwd: root, env: process.env,
      encoding: 'utf8', timeout: 90_000,
    });
  }

  it('rejects independently named post, comment, thread, count, search, feed and notification readers', () => {
    const root = createProbeCopy();
    try {
      const names = ['unsafePost', 'unsafeComment', 'unsafeThread', 'unsafeCount',
        'unsafeSearch', 'unsafeFeed', 'unsafeNotification'];
      writeFileSync(join(root, 'src/ls-1185r5-surface-probe.ts'), `
        export const unsafePost = (p: any) => p.communityPost.findMany({});
        export const unsafeComment = (p: any) => p.communityMessage.findMany({ where: { post_id: 'post' } });
        export const unsafeThread = (p: any) => p.communityMessage.findMany({ where: { parent_message_id: 'thread' } });
        export const unsafeCount = (p: any) => p.communityMessage.count({});
        export const unsafeSearch = (p: any) => p.communitySearchEntry.findMany({});
        export const unsafeFeed = (p: any) => p.communityWin.findMany({});
        export const unsafeNotification = (p: any) => p.coachMessage.findMany({ where: { read_at: null } });
      `);
      const readSites = scanMemberContentReads(join(root, 'src'));
      for (const name of names) expect(readSites.some((site) => site.reader === name)).toBe(true);
      const result = gate(root);
      expect(result.status).toBe(1);
      for (const name of names) expect(result.stdout + result.stderr).toContain(name);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 100_000);

  it('rejects an unsafe named relation filter even when its where object and some condition are held separately', () => {
    const root = createProbeCopy();
    try {
      writeFileSync(join(root, 'src/ls-1185r5-held-filter.ts'), `
        import type { PrismaClient, Prisma } from '@prisma/client';
        const authored: Prisma.CommunityPostListRelationFilter = {
          some: { body: { contains: 'query' } },
        };
        const where: Prisma.UserWhereInput = { community_posts_authored: authored };
        export const unsafeHeldFilter = (prisma: PrismaClient) =>
          prisma.user.findMany({ where });
      `);
      const result = gate(root);
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain('unsafeHeldFilter');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 100_000);
});
