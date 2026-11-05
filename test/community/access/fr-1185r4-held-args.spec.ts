/**
 * FR-1185R4 class tests (owner #189-D3 op 1; LS-1185R5 B1 and LS-1185R4 B2 are two members of the class): the
 * checker follows a where, a select, an include or a count argument that is kept in a variable, spread, built by
 * a helper (also in another file) or built in a loop or a branch, back to where it is made, at the read call
 * that uses it. Each form below holds a relation into members' content; at the read on a model that can reach
 * members' content it is a read of the function that makes the call. The same forms on a model that cannot
 * reach members' content stay quiet, and a form the checker cannot follow at all fails closed ('*').
 *
 * The real gate: an unregistered read of one of these forms turns 'finds no unregistered read' red; registered
 * with all four rules decided it is green; registered with a rule left undecided (it skips ban) it is red.
 * Test-only; no runtime changes.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProbeCopy } from './ls-1185-probe-copy';
import { ANY_MODEL, scanMemberContentReads } from './member-content-scan';

/** The filter a member-content relation is read with, held apart from the where (LS-1185R5 B1). */
const AUTHORED = 'const authored = { some: { body: { contains: "query" } } };';
/** A to-one relation filter without `is` (the limit L10 shape), held apart. */
const UNREAD = 'const unread = { read_at: null };';
const SELECTED = 'const fields = { body: true };';

type Form = [name: string, files: Record<string, string>, reader: string, model: string];

/** Member-reaching models (User, CoachBroadcastDelivery, CommunityCohort): each form is a read of `reader`. */
const reaching: Form[] = [
  ['a where held in a const, then passed', { 'probe.ts': `${AUTHORED} const where = { community_posts_authored: authored };
    export const read = (p: any) => p.user.findMany({ where });` }, 'read', 'CommunityPost'],
  ['a where spread from another object', { 'probe.ts': `${AUTHORED} const base = { community_posts_authored: authored };
    export const read = (p: any) => p.user.findMany({ where: { ...base, role: "student" } });` }, 'read', 'CommunityPost'],
  ['a where returned by a helper in another file', {
    'filters.ts': `${AUTHORED} export function authoredBy() { return { community_posts_authored: authored }; }`,
    'probe.ts': `import { authoredBy } from './filters';
    export const read = (p: any) => p.user.findMany({ where: authoredBy() });` }, 'read', 'CommunityPost'],
  ['a where built in a loop', { 'probe.ts': `${AUTHORED}
    export const read = (p: any, keys: string[]) => {
      const where: Record<string, unknown> = { role: "student" };
      for (const k of keys) if (k === "posts") where.community_posts_authored = authored;
      return p.user.findMany({ where });
    };` }, 'read', 'CommunityPost'],
  ['a where built in a branch', { 'probe.ts': `${UNREAD}
    export const read = (p: any, unreadOnly: boolean) => {
      let where: Record<string, unknown> = { broadcast_id: "b" };
      if (unreadOnly) where = { ...where, message: unread };
      return p.coachBroadcastDelivery.findMany({ where });
    };` }, 'read', 'CoachMessage'],
  ['a where pushed into AND', { 'probe.ts': `${AUTHORED}
    export const read = (p: any) => {
      const and: object[] = [];
      and.push({ community_posts_authored: authored });
      return p.user.findMany({ where: { AND: and } });
    };` }, 'read', 'CommunityPost'],
  ['a where handed in by the caller', { 'probe.ts': `${AUTHORED}
    function list(p: any, where: object) { return p.user.findMany({ where }); }
    export const read = (p: any) => list(p, { community_posts_authored: authored });` }, 'list', 'CommunityPost'],
  ['a select held in a const', { 'probe.ts': `${SELECTED} const SELECT = { id: true, community_posts_authored: { select: fields } };
    export const read = (p: any) => p.user.findMany({ select: SELECT });` }, 'read', 'CommunityPost'],
  ['a select spread from another object', { 'probe.ts': `${SELECTED} const BASE = { community_posts_authored: { select: fields } };
    export const read = (p: any) => p.user.findMany({ select: { id: true, ...BASE } });` }, 'read', 'CommunityPost'],
  ['a select returned by a helper in another file', {
    'selects.ts': `${SELECTED} export const authorSelect = () => ({ author: { select: { id: true, community_posts_authored: { select: fields } } } });`,
    'probe.ts': `import { authorSelect } from './selects';
    export const read = (p: any) => p.communityCohort.findMany({ select: { id: true, posts: false, voice_notes: false, ...authorSelect() } });` },
  'read', 'CommunityPost'],
  ['a select built in a branch', { 'probe.ts': `${SELECTED}
    export const read = (p: any, withPosts: boolean) => {
      const select: Record<string, unknown> = { id: true };
      if (withPosts) select.community_posts_authored = { select: fields };
      return p.user.findMany({ select });
    };` }, 'read', 'CommunityPost'],
  ['an include held in a const', { 'probe.ts': `${UNREAD} const INCLUDE = { message: { select: { id: true } } };
    export const read = (p: any) => p.coachBroadcastDelivery.findMany({ include: INCLUDE });` }, 'read', 'CoachMessage'],
  ['an include built in a loop', { 'probe.ts': `
    export const read = (p: any, names: string[]) => {
      const include: Record<string, unknown> = {};
      for (const n of names) include[n] = true;
      return p.communityCohort.findMany({ include });
    };` }, 'read', ANY_MODEL],
  ['a count with a held where', { 'probe.ts': `${AUTHORED} const where = { community_posts_authored: authored };
    export const read = (p: any) => p.user.count({ where });` }, 'read', 'CommunityPost'],
  ['a relation count with a held where', { 'probe.ts': `${AUTHORED} const memberships = { where: { user: { community_posts_authored: authored } } };
    export const read = (p: any) => p.communityWorkspace.findMany({ select: { _count: { select: { memberships } } } });` }, 'read', 'CommunityPost'],
  ['`_count: true` held in a const', { 'probe.ts': `const COUNTS = { _count: true };
    export const read = (p: any) => p.user.findMany({ include: COUNTS });` }, 'read', ANY_MODEL],
];

/** A model that cannot reach members' content (BuildWeekEnrollment, DiagnosticSubmission): the same forms stay quiet. */
const quiet: Array<[name: string, source: string]> = [
  ['on a model that cannot reach members\' content, a held relation filter', `const done = { some: { day: 1 } }; const where = { completions: done };
    export const read = (p: any) => p.buildWeekEnrollment.findMany({ where });`],
  ['on a model that cannot reach members\' content, a where built in a loop', `export const read = (p: any, keys: string[]) => {
      const where: Record<string, unknown> = {};
      for (const k of keys) where[k] = null;
      return p.buildWeekEnrollment.findMany({ where });
    };`],
  ['on a model that cannot reach members\' content, a held select and include', `const SELECT = { id: true, roadmap: true }; const INCLUDE = { _count: true };
    export const read = (p: any) => [p.diagnosticSubmission.findMany({ select: SELECT }), p.diagnosticSubmission.findMany({ include: INCLUDE })];`],
  ['on a model that cannot reach members\' content, a where it cannot follow', `export const read = (p: any, where: any) => p.buildWeekEnrollment.count({ where });`],
  ['a held scalar filter (no relation) on a model that can reach members\' content', `const q = { contains: "query" }; const where = { full_name: q };
    export const read = (p: any) => p.user.findMany({ where });`],
];

/** Forms the checker cannot follow at all, on a model that can reach members' content: FAIL CLOSED. */
const unfollowable: Array<[name: string, source: string, reader: string]> = [
  ['a where nobody in the scan builds', 'export const read = (p: any, where: any) => p.user.findMany({ where });', 'read'],
  ['a where from a callback parameter', 'export const read = (p: any, list: any[]) => list.map((where) => p.communityPost.count({ where }));', 'read'],
  ['a select from a package call', `import { pick } from 'some-package';
    export const read = (p: any) => p.user.findMany({ select: pick() });`, 'read'],
  ['a where with a key it cannot name', `export const read = (p: any, key: string) => p.user.findMany({ where: { [key]: { some: {} } } });`, 'read'],
  ['a where handed to a package helper that may add keys', `import { addFilters } from 'some-package';
    export const read = (p: any) => { const where = { role: "student" }; addFilters(where); return p.user.findMany({ where }); };`, 'read'],
];

function scan(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'fr1185r4-held-'));
  try {
    for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source);
    return scanMemberContentReads(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('FR-1185R4: a held, spread, helper-built or loop-built argument is followed back to where it is made', () => {
  it.each(reaching)('%s is a read of the function that makes the call', (_name, files, reader, model) => {
    expect(scan(files).map((s) => `${s.reader} ${s.model}`)).toContain(`${reader} ${model}`);
  });
  it.each(quiet)('%s stays quiet', (_name, source) => {
    expect(scan({ 'probe.ts': source })).toEqual([]);
  });
  it.each(unfollowable)('%s fails closed', (_name, source, reader) => {
    expect(scan({ 'probe.ts': source }).map((s) => `${s.reader} ${s.model}`)).toContain(`${reader} ${ANY_MODEL}`);
  });
});

describe('FR-1185R4: the real gate on a held argument', () => {
  const PROBE = `${AUTHORED}
    export function authoredWhere(keys: string[]) {
      const where: Record<string, unknown> = {};
      for (const k of keys) if (k === 'posts') where.community_posts_authored = authored;
      return where;
    }`;
  const READER = `import { authoredWhere } from './fr-1185r4-filters';
    export const heldArgReader = (p: any) => p.user.findMany({ where: authoredWhere(['posts']) });`;
  const ROW = (ban: string) => `  r('fr-1185r4-reader.ts', 'heldArgReader', ['CommunityPost'], 'shown', 'probe: members by a post they wrote', {
    block: 'filterBlocked on the authors', ban: ${JSON.stringify(ban)}, removed: 'deleted_at: null on the post',
    departed: 'authorsWhoLeft on the authors' }),\n`;
  function gate(root: string) {
    const scratch = mkdtempSync(join(tmpdir(), 'fr1185r4-gate-'));
    const report = join(scratch, 'result.json');
    try {
      const run = spawnSync(process.execPath, [
        require.resolve('jest/bin/jest'), '--runInBand', '--no-cache', '--json', `--outputFile=${report}`,
        '--testNamePattern=finds no unregistered read|all four rules decided',
        'test/community/access/member-content-access.spec.ts',
      ], { cwd: root, encoding: 'utf8', timeout: 110000, maxBuffer: 1024 * 1024 * 8 });
      if (run.error) throw run.error;
      const result = JSON.parse(readFileSync(report, 'utf8')) as {
        numFailedTests: number; numPassedTests: number;
        testResults: Array<{ assertionResults: Array<{ title: string; status: string }> }>;
      };
      const status = Object.fromEntries(result.testResults.flatMap((t) => t.assertionResults.map((a) => [a.title, a.status])));
      return { status, output: `${run.stdout}\n${run.stderr}` };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  function probe(row?: string) {
    const root = createProbeCopy();
    writeFileSync(join(root, 'src/fr-1185r4-filters.ts'), PROBE);
    writeFileSync(join(root, 'src/fr-1185r4-reader.ts'), READER);
    if (row !== undefined) {
      const registry = join(root, 'test/community/access/member-content-readers.ts');
      const text = readFileSync(registry, 'utf8');
      writeFileSync(registry, text.replace('const ROWS: RegisteredReader[] = [\n', `const ROWS: RegisteredReader[] = [\n${row}`));
    }
    return root;
  }

  it('an unregistered read through a loop-built where from another file turns the gate red', () => {
    const root = probe();
    try {
      const { status, output } = gate(root);
      expect(status['finds no unregistered read']).toBe('failed');
      expect(output).toContain('heldArgReader reads CommunityPost');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120000);

  it('registered with block, ban, removal and departure decided, the same read is green', () => {
    const root = probe(ROW('filterBlocked with the space as place (app.community_author_unbanned)'));
    try {
      const { status } = gate(root);
      expect(status['finds no unregistered read']).toBe('passed');
      expect(status['lists each reader once, with known models and all four rules decided']).toBe('passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120000);

  it('registered with the ban rule skipped, the same read is red', () => {
    const root = probe(ROW(''));
    try {
      const { status, output } = gate(root);
      expect(status['lists each reader once, with known models and all four rules decided']).toBe('failed');
      expect(output).toContain('heldArgReader: the ban rule is not decided');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120000);
});
