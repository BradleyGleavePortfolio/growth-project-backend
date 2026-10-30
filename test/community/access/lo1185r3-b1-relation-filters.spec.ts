/**
 * LO-1185R3 B1 B-TEST (KT-2): a relation filter or a relation-count order on a member-content relation reads that
 * table (Postgres runs an EXISTS / count over it), the same read the scan already reports for the raw SQL
 * (`EXISTS (SELECT 1 FROM community_messages ...)`) and for `_count` in a select. A list of people filtered or ordered
 * by what they wrote returns the names of blocked, banned and departed authors and matches removed words, so each
 * form must be a read site. Red at ca3cc960; the controls stay green. Test-only file.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { scanMemberContentReads } from './member-content-scan';

function modelsOf(source: string): string[] {
  const root = mkdtempSync(join(tmpdir(), 'lo1185r3-b1-'));
  try {
    writeFileSync(join(root, 'probe.ts'), source);
    return scanMemberContentReads(root).map((s) => s.model);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const FILTERS: Array<[string, string, string]> = [
  ['a some filter on what members wrote',
    'export const f = (prisma: any, q: string) => prisma.user.findMany({ where: { community_messages_sent: { some: { body: { contains: q } } } }, select: { id: true, full_name: true } });',
    'CommunityMessage'],
  ['a none filter on member posts',
    'export const f = (prisma: any) => prisma.user.findMany({ where: { community_posts_authored: { none: {} } } });',
    'CommunityPost'],
  ['an every filter on member posts',
    'export const f = (prisma: any) => prisma.user.count({ where: { community_posts_authored: { every: { deleted_at: null } } } });',
    'CommunityPost'],
  ['an order by the count of member posts',
    "export const f = (prisma: any) => prisma.user.findMany({ orderBy: { community_posts_authored: { _count: 'desc' } }, take: 10 });",
    'CommunityPost'],
];

describe('LO-1185R3 B1: relation filters and relation-count orders are member-content reads', () => {
  it.each(FILTERS)('the scan reports %s', (_form, source, model) => {
    expect(modelsOf(source)).toContain(model);
  });

  it('control: a filter on a plain column of a person is not a read site', () => {
    expect(modelsOf("export const f = (prisma: any, q: string) => prisma.user.findMany({ where: { full_name: { contains: q } } });")).toEqual([]);
  });
});
