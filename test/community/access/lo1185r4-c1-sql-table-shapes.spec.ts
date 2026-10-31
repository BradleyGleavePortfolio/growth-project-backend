// LO-1185R4 C1 (round 4, Opus lens): the SQL table rule (sqlReadsTable, member-content-scan.ts:183-187) reads only
// `FROM|JOIN <space> [schema.]table` and comma lists of plain names. Anything between the keyword and the name hides
// the table: a comment, `ONLY`, a parenthesised join, or a function item first in a FROM list. Each read below skips
// blocks and bans and must be a site of the scan. Red at 26c1cc0d.
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { scanMemberContentReads } from './member-content-scan';

const raw = (sql: string) =>
  `import { PrismaClient } from '@prisma/client';\nexport const f = (prisma: PrismaClient) => prisma.$queryRaw\`${sql}\`;\n`;

const SHAPES: Array<[string, string, string]> = [
  ['a block comment between FROM and the table', 'SELECT p.body FROM /* posts */ community_posts p', 'CommunityPost'],
  ['a line comment between FROM and the table', 'SELECT p.body FROM -- the posts\n community_posts p', 'CommunityPost'],
  ['a block comment between JOIN and the table', 'SELECT m.body FROM users u JOIN /* m */ community_messages m ON m.sender_id = u.id', 'CommunityMessage'],
  ['FROM ONLY', 'SELECT p.body FROM ONLY community_posts p', 'CommunityPost'],
  ['a parenthesised join', 'SELECT p.body FROM (community_posts p JOIN users u ON u.id = p.author_id)', 'CommunityPost'],
  ['a function item first in a FROM list', 'SELECT p.body FROM unnest(ARRAY[1]) AS x, community_posts p', 'CommunityPost'],
];

function models(source: string): string[] {
  const root = mkdtempSync(join(tmpdir(), 'lo1185r4-c1-'));
  try {
    writeFileSync(join(root, 'preview.ts'), source);
    return scanMemberContentReads(root).filter((s) => s.file.endsWith('/preview.ts')).map((s) => s.model);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('LO-1185R4 C1: SQL table shapes the table rule misses', () => {
  it.each(SHAPES)('the scan reports a raw read with %s', (_shape, sql, model) => {
    expect(models(raw(sql))).toContain(model);
  });
  it('control: the house shape is a site', () => {
    expect(models(raw('SELECT p.body FROM community_posts p'))).toContain('CommunityPost');
  });
});
