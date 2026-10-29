/**
 * KT-2 (KNOWN_TRAPS.md): every read of member content honors a block (both ways), a ban (the whole community),
 * a removal and a departure. One shared contract test for every backend PR.
 *
 * It has three parts:
 *   1. the registry (member-content-readers.ts): every runtime function that reads a member-content table, what it
 *      returns, and how it applies each of the four rules (applied, "n/a:" with why, or "GAP:" for a KNOWN GAP);
 *   2. the architecture check: it reads src/ (never a test) and finds every read of a member-content table
 *      (member-content-scan.ts); a read in a function the registry does not list fails, naming the file and line;
 *   3. the behavior check: for the readers the in-memory community double can run, one table of authors under each
 *      rule; their words, rows, names and counts must not reach the viewer, while a control member's do.
 *
 * WHEN THIS TEST IS RED, the builder must do one of these, and never loosen the test:
 *   - "unregistered read": register the new or moved read in member-content-readers.ts, with each of the four rules
 *     and how the code applies it (filterBlocked or assertVisibleTo WITH the space as place, rowsByAuthorsWhoStay,
 *     authorsWhoLeft, unbannedSpaces, inBlockWith, ...);
 *   - a behavior row is red: apply the rule in the read, the same way the registered readers do;
 *   - the rule cannot be applied in your PR: ask the operator for a KNOWN GAP row ("GAP:" in the registry, with
 *     where it was found); never add one on your own;
 *   - "KNOWN GAP fixed": a gap row now hides the author; replace its "GAP:" text in the registry with how the rule
 *     is applied now, and the row becomes a normal check that must stay green.
 * Test-only file: nothing here changes runtime code.
 */
import 'reflect-metadata';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { User } from '@prisma/client';
import { MEMBER_CONTENT_MODELS, scanMemberContentReads, type ReadSite } from './member-content-scan';
import { MEMBER_CONTENT_READERS, readerKey, type RegisteredReader } from './member-content-readers';
import { ACCESS_RULES, RULE_COLUMN, accessWorld, type AccessRule, type AccessWorld } from './member-content-fixture';

const RULES = ['block', 'ban', 'removed', 'departed'] as const;
const isGap = (rule: string) => rule.startsWith('GAP:');
const isNa = (rule: string) => rule.startsWith('n/a:');

const registry = new Map<string, RegisteredReader>();
for (const row of MEMBER_CONTENT_READERS) registry.set(readerKey(row.file, row.reader), row);

describe('KT-2 member-content registry', () => {
  it('lists each reader once, with known models and all four rules decided', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const row of MEMBER_CONTENT_READERS) {
      const key = readerKey(row.file, row.reader);
      if (seen.has(key)) problems.push(`${key}: listed twice`);
      seen.add(key);
      for (const m of row.models) if (!(m in MEMBER_CONTENT_MODELS)) problems.push(`${key}: ${m} is not a member-content model`);
      for (const rule of RULES) if (!row[rule]?.trim()) problems.push(`${key}: the ${rule} rule is not decided`);
      if (RULES.some((rule) => isGap(row[rule])) && !row.found) problems.push(`${key}: a KNOWN GAP must say where it was found`);
      if (row.kind === 'check' && RULES.some((rule) => isGap(row[rule]))) problems.push(`${key}: a lookup cannot hold a GAP`);
    }
    expect(problems).toEqual([]);
  });
});

describe('KT-2 architecture: every read of a member-content table under src/ is registered', () => {
  let sites: ReadSite[] = [];
  beforeAll(() => {
    sites = scanMemberContentReads();
  });

  it('finds no unregistered read', () => {
    const missing = sites
      .filter((s) => !registry.get(readerKey(s.file, s.reader))?.models.includes(s.model))
      .map(
        (s) =>
          `${s.file}:${s.line} ${s.reader} reads ${s.model} (${s.via}) and is not registered. KT-2 (KNOWN_TRAPS.md): ` +
          'add it to test/community/access/member-content-readers.ts with how it applies block (both ways), ban, ' +
          'removal and departure, or ask the operator for a KNOWN GAP row.',
      );
    if (missing.length > 0) throw new Error(`Unregistered member-content reads:\n${missing.join('\n')}`);
  });

  it('has no stale row (every registered reader still reads each model it lists)', () => {
    const read = new Set(sites.map((s) => `${readerKey(s.file, s.reader)} ${s.model}`));
    const stale = MEMBER_CONTENT_READERS.flatMap((row) =>
      row.models.filter((m) => !read.has(`${readerKey(row.file, row.reader)} ${m}`)).map((m) => `${readerKey(row.file, row.reader)} no longer reads ${m}: update or remove the row`),
    );
    expect(stale).toEqual([]);
  });

  it('the scan sees Prisma reads, raw SQL, relation includes and aliased models, and ignores writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'kt2-scan-'));
    try {
      mkdirSync(join(root, '__tests__'));
      writeFileSync(
        join(root, 'probe.ts'),
        [
          'export class Probe {',
          '  constructor(private readonly prisma: any) {}',
          '  async list() { return this.prisma.communityMessage.findMany({ where: {} }); }',
          '  async write() { return this.prisma.communityPost.create({ data: {} }); }',
          '  async raw() { return this.prisma.$queryRaw`SELECT 1 FROM "community_posts" p`; }',
          '  async withReplies() { return this.prisma.user.findMany({ include: { community_messages_sent: true } }); }',
          '  delegate() { return this.prisma.coachMessage; }',
          '}',
          'export const counted = (tx: any) => tx.communityVoiceNote.count({});',
        ].join('\n'),
      );
      writeFileSync(join(root, '__tests__', 'ignored.ts'), 'export const x = (p: any) => p.communityMessage.findMany({});');
      writeFileSync(join(root, 'probe.spec.ts'), 'export const y = (p: any) => p.communityMessage.findMany({});');
      const found = scanMemberContentReads(root).map((s) => `${s.line} ${s.reader} ${s.model} ${s.via}`);
      expect(found.sort()).toEqual(
        [
          '3 Probe.list CommunityMessage prisma',
          '5 Probe.raw CommunityPost sql',
          '6 Probe.withReplies CommunityMessage relation',
          '7 Probe.delegate CoachMessage aliased',
          '9 counted CommunityVoiceNote prisma',
        ].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the scan of src/ is not blind (each read form is present in the real code)', () => {
    const vias = new Set(sites.map((s) => s.via));
    expect(vias.has('prisma') && vias.has('sql') && vias.has('relation')).toBe(true);
    expect(new Set(sites.map((s) => s.model)).size).toBe(Object.keys(MEMBER_CONTENT_MODELS).length);
  });
});

// ── Behavior: one author per rule, one control member, read as the viewer ───────────────────────────────────

interface Written {
  id: string;
  table: string;
}

interface BehaviorRead {
  /** Equals `behavior` on the registry row. */
  name: string;
  file: string;
  reader: string;
  /** The author writes `words`; returns the row a removal applies to. */
  write(w: AccessWorld, author: User, words: string): Promise<Written>;
  /** The viewer reads; `author` and `row` say whose item a per-item read asks for. */
  read(w: AccessWorld, author: User, row: Written): Promise<unknown>;
  /** 'words' when the read returns the words; 'people' when it returns only who (a thread list, a count). */
  shows: 'words' | 'people' | 'count';
  count?(out: unknown, w: AccessWorld): number;
}

const settle = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    return await p;
  } catch (e) {
    return { refused: e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e) };
  }
};

const BEHAVIOR_READS: BehaviorRead[] = [
  {
    name: 'space chat list',
    file: 'src/community/messages/community-messages.repository.ts',
    reader: 'CommunityMessagesRepository.listCohortMessages',
    write: async (w, a, words) => ({ id: (await w.messages.send(a, w.cohortId, words)).message.id, table: 'communityMessage' }),
    read: (w) => w.messages.list(w.viewer, w.cohortId, {}),
    shows: 'words',
  },
  {
    name: 'space message by id',
    file: 'src/community/messages/community-messages.repository.ts',
    reader: 'CommunityMessagesRepository.findById',
    write: async (w, a, words) => ({ id: (await w.messages.send(a, w.cohortId, words)).message.id, table: 'communityMessage' }),
    read: (w, _a, row) => w.messages.getOne(w.viewer, row.id),
    shows: 'words',
  },
  {
    name: 'post comments',
    file: 'src/community/messages/community-messages.repository.ts',
    reader: 'CommunityMessagesRepository.listComments',
    write: async (w, a, words) => ({ id: (await w.posts.addComment(a, w.postId, words)).comment.id, table: 'communityMessage' }),
    read: (w) => w.posts.listComments(w.viewer, w.postId),
    shows: 'words',
  },
  {
    name: 'DM thread list',
    file: 'src/community/dms/community-dms.repository.ts',
    reader: 'CommunityDmsRepository.listThreadsForUser',
    write: async (w, a, words) => ({ id: (await w.dms.send(a, w.wsId, w.viewer.id, words)).message.id, table: 'communityMessage' }),
    read: (w) => w.dms.listThreads(w.viewer, w.wsId, {}),
    shows: 'people',
  },
  {
    name: 'DM thread page',
    file: 'src/community/dms/community-dms.repository.ts',
    reader: 'CommunityDmsRepository.listThread',
    write: async (w, a, words) => ({ id: (await w.dms.send(a, w.wsId, w.viewer.id, words)).message.id, table: 'communityMessage' }),
    read: (w, a) => w.dms.listThread(w.viewer, w.wsId, a.id, {}),
    shows: 'words',
  },
  {
    name: 'post reaction counts',
    file: 'src/community/reactions/community-reactions.repository.ts',
    reader: 'CommunityReactionsRepository.listForTargets',
    write: async (w, a) => {
      const row = w.db.seed('communityResponse', {
        workspace_id: w.wsId,
        target_type: 'post',
        target_id: w.postId,
        user_id: a.id,
        response_kind: '\u{1F44D}',
      });
      return { id: row.id as string, table: 'communityResponse' };
    },
    read: (w) => w.posts.list(w.viewer, w.wsId, {}),
    shows: 'count',
    count: (out, w) => {
      const posts = (out as { posts?: Array<{ id: string; reactions?: Array<{ count: number }> }> }).posts ?? [];
      return (posts.find((p) => p.id === w.postId)?.reactions ?? []).reduce((n, r) => n + r.count, 0);
    },
  },
];

describe('KT-2 behavior: the registered readers that run in memory honor all four rules', () => {
  it('every behavior row matches its registry row, both ways', () => {
    const named = new Set(BEHAVIOR_READS.map((b) => readerKey(b.file, b.reader)));
    const problems = [
      ...BEHAVIOR_READS.filter((b) => registry.get(readerKey(b.file, b.reader))?.behavior !== b.name).map(
        (b) => `${b.name}: the registry row ${readerKey(b.file, b.reader)} must say behavior: '${b.name}'`,
      ),
      ...MEMBER_CONTENT_READERS.filter((r) => r.behavior && !named.has(readerKey(r.file, r.reader))).map(
        (r) => `${readerKey(r.file, r.reader)} says behavior '${r.behavior}' but no behavior row runs it`,
      ),
    ];
    expect(problems).toEqual([]);
  });

  for (const b of BEHAVIOR_READS) {
    const key = readerKey(b.file, b.reader);
    const row = registry.get(key);
    describe(b.name, () => {
      for (const rule of ACCESS_RULES) {
        const decided = row?.[RULE_COLUMN[rule]] ?? '';
        if (isNa(decided)) continue;
        const gap = isGap(decided);
        const title = gap
          ? `KNOWN GAP (KT-2): an author ${rule} still shows (registry: ${decided})`
          : `an author ${rule}: no words, no row, no name, not counted; the control member still shows`;
        it(title, async () => {
          const { controlShown, leaked } = await runCase(b, rule);
          // The control proves the read works, so an absent author is never a vacuous pass.
          expect(controlShown).toBe(true);
          if (!gap) {
            expect(leaked).toEqual([]);
          } else if (leaked.length === 0) {
            throw new Error(
              `KNOWN GAP fixed: ${key} now hides an author ${rule}. Replace its "GAP:" text in ` +
                'test/community/access/member-content-readers.ts with how the rule is applied now (KT-2).',
            );
          }
        });
      }
    });
  }
});

/** One author under `rule`, one control member, read as the viewer: what of the author reached the viewer. */
async function runCase(b: BehaviorRead, rule: AccessRule): Promise<{ controlShown: boolean; leaked: string[] }> {
  const w = await accessWorld();
  const author = w.member('Hidden Author');
  const hiddenWords = `hidden words ${b.name} ${rule}`;
  const controlWords = `control words ${b.name}`;
  const hiddenRow = await b.write(w, author, hiddenWords);
  const controlRow = await b.write(w, w.control, controlWords);
  await w.apply(rule, author, hiddenRow);

  const shownOut = await settle(b.read(w, w.control, controlRow));
  const hiddenOut = await settle(b.read(w, author, hiddenRow));
  const shown = JSON.stringify(shownOut);
  const hidden = JSON.stringify(hiddenOut);
  const leaked: string[] = [];
  if (hidden.includes(hiddenWords)) leaked.push('words');
  if (rule !== 'removed or deleted') {
    if (hidden.includes(author.id)) leaked.push('row or id');
    if (hidden.includes('Hidden Author')) leaked.push('name');
  }
  let controlShown = b.shows === 'words' ? shown.includes(controlWords) : shown.includes(w.control.id);
  if (b.shows === 'count' && b.count) {
    controlShown = b.count(shownOut, w) >= 1;
    // Only the control member's item may count.
    if (b.count(hiddenOut, w) !== 1) leaked.push(`count ${b.count(hiddenOut, w)} (only the control member's 1 may count)`);
  }
  return { controlShown, leaked };
}
