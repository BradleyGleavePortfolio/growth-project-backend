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
 *      rule; their words, rows, names and counts must not reach the viewer, while a control member's do; and the
 *      coaching-chat readers (member-content-coach-reads.ts), with the coach as the viewer. Every GAP row has a
 *      case here, so a fixed gap turns its row red.
 *
 * WHEN THIS TEST IS RED, the builder must do one of these, and never loosen the test:
 *   - "unregistered read": register the new or moved read in member-content-readers.ts, with each of the four rules
 *     and how the code applies it (filterBlocked or assertVisibleTo WITH the space as place, rowsByAuthorsWhoStay,
 *     authorsWhoLeft, unbannedSpaces, inBlockWith, ...); a new caller of a reader whose rules live in its caller
 *     (a repository reader, a repository wrapper, a row with `callers`): apply the rules, then add it to that row's
 *     callers; a caller that fails closed (`?.name`: an `any` receiver or a computed key) names the reader so the
 *     scan can resolve it;
 *   - a behavior row is red: apply the rule in the read, the same way the registered readers do;
 *   - the rule cannot be applied in your PR: ask the operator for a KNOWN GAP row ("GAP:" in the registry, with
 *     where it was found); never add one on your own;
 *   - "KNOWN GAP fixed": a gap row now hides the author; replace its "GAP:" text in the registry with how the rule
 *     is applied now, and the row becomes a normal check that must stay green.
 * Test-only file: nothing here changes runtime code.
 */
import 'reflect-metadata';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { User } from '@prisma/client';
import { ANY_MODEL, MEMBER_CONTENT_MODELS, REPO_ROOT, scanMemberContentReads, type ReadSite, type ScanOptions } from './member-content-scan';
import { MEMBER_CONTENT_READERS, readerKey, type RegisteredReader } from './member-content-readers';
import { ACCESS_RULES, RULE_COLUMN, accessWorld, type AccessRule, type AccessWorld } from './member-content-fixture';
import { COACH_READS, applyCoachRule, seedCoachMessage, type CoachRead } from './member-content-coach-reads';
import { CommunityReactionsService } from '../../../src/community/reactions/community-reactions.service';
import { CommunityReactionsRepository } from '../../../src/community/reactions/community-reactions.repository';

const RULES = ['block', 'ban', 'removed', 'departed'] as const;
const isGap = (rule: string) => rule.startsWith('GAP:');
const isNa = (rule: string) => rule.startsWith('n/a:');

const registry = new Map<string, RegisteredReader>();
for (const row of MEMBER_CONTENT_READERS) registry.set(readerKey(row.file, row.reader), row);
/** The registry row of a reader that leaves the rules to its callers, by `Class.method` (the callee of a `caller` site). */
const callerRow = (callee: string | undefined) => MEMBER_CONTENT_READERS.find((row) => row.reader === callee);
const PASS_THROUGH = MEMBER_CONTENT_READERS.filter((row) => row.callers).map((row) => row.reader);

describe('KT-2 member-content registry', () => {
  it('lists each reader once, with known models and all four rules decided', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const row of MEMBER_CONTENT_READERS) {
      const key = readerKey(row.file, row.reader);
      if (seen.has(key)) problems.push(`${key}: listed twice`);
      seen.add(key);
      for (const m of row.models) {
        if (!(m in MEMBER_CONTENT_MODELS) && m !== ANY_MODEL) problems.push(`${key}: ${m} is not a member-content model`);
      }
      for (const rule of RULES) if (!row[rule]?.trim()) problems.push(`${key}: the ${rule} rule is not decided`);
      const gaps = RULES.filter((rule) => isGap(row[rule]));
      if (gaps.length && !row.found) problems.push(`${key}: a KNOWN GAP must say where it was found`);
      if (row.kind === 'check' && gaps.length) problems.push(`${key}: a lookup cannot hold a GAP`);
      // LO-1185 C1, LS-1185 B2: a GAP is executable, so fixing the runtime turns it red ("KNOWN GAP fixed").
      if (gaps.length && !row.behavior) problems.push(`${key}: a KNOWN GAP needs a behavior case that runs the reader`);
      const coach = COACH_READS.find((c) => readerKey(c.file, c.reader) === key);
      for (const rule of gaps) {
        if (coach && !coach.runs.some((r) => RULE_COLUMN[r] === rule)) problems.push(`${key}: its ${rule} GAP is not run by '${coach.name}'`);
      }
      // LO-1185 C3: a `covered:` pointer names files that exist.
      for (const path of row.covered?.match(/(?:test|src)\/[\w./-]+\.ts/g) ?? []) {
        if (!existsSync(join(REPO_ROOT, path))) problems.push(`${key}: covered names ${path}, which does not exist`);
      }
      if (row.callers && row.callers.length === 0) problems.push(`${key}: callers lists no caller; remove it`);
    }
    expect(problems).toEqual([]);
  });
});

describe('KT-2 architecture: every read of a member-content table under src/ is registered', () => {
  let sites: ReadSite[] = [];
  beforeAll(() => {
    // Rows that list callers are readers whose rules live in their callers (LO-1185R2 C1: MessagingService.listThread).
    sites = scanMemberContentReads(undefined, { passThrough: PASS_THROUGH });
  });

  it('finds no unregistered read', () => {
    const missing = sites
      .filter((s) => !registry.get(readerKey(s.file, s.reader))?.models.includes(s.model))
      .filter((s) => !(s.via === 'caller' && callerRow(s.callee)?.callers?.includes(s.reader)))
      .map((s) =>
        s.via === 'caller' && s.callee?.startsWith('?.')
          ? `${s.file}:${s.line} ${s.reader} references ${s.callee} on a value the scan cannot type (any) or by a key it ` +
            'cannot name, where a reader that leaves the rules to its caller fits (FAIL CLOSED). KT-2 (KNOWN_TRAPS.md): ' +
            'type the receiver or name the method, so the scan can tell which reader it calls.'
          : s.via === 'caller'
          ? `${s.file}:${s.line} ${s.reader} calls ${s.callee}, which reads ${s.model} and leaves the rules to its ` +
            'caller, and is not registered. KT-2 (KNOWN_TRAPS.md): apply block (both ways), ban, removal and departure ' +
            `in ${s.reader}, then add it to the callers of ${s.callee} in test/community/access/member-content-readers.ts.`
          : `${s.file}:${s.line} ${s.reader} reads ${s.model} (${s.via}) and is not registered. KT-2 (KNOWN_TRAPS.md): ` +
            'add it to test/community/access/member-content-readers.ts with how it applies block (both ways), ban, ' +
            'removal and departure, or ask the operator for a KNOWN GAP row.',
      );
    if (missing.length > 0) throw new Error(`Unregistered member-content reads:\n${[...new Set(missing)].join('\n')}`);
  });

  it('has no stale row (every registered reader still reads each model it lists, every listed caller still calls)', () => {
    const read = new Set(sites.map((s) => `${readerKey(s.file, s.reader)} ${s.model}`));
    const calls = new Set(sites.filter((s) => s.via === 'caller').map((s) => `${s.callee} <- ${s.reader}`));
    const stale = MEMBER_CONTENT_READERS.flatMap((row) => [
      ...row.models.filter((m) => !read.has(`${readerKey(row.file, row.reader)} ${m}`)).map((m) => `${readerKey(row.file, row.reader)} no longer reads ${m}: update or remove the row`),
      ...(row.callers ?? []).filter((c) => !calls.has(`${row.reader} <- ${c}`)).map((c) => `${row.reader}: ${c} no longer calls it; remove it from callers`),
    ]);
    expect(stale).toEqual([]);
  });

  // LO-1185 B1 and LS-1185 B1: every way a read can be written is a read site (class-first: one row per form).
  const FORMS: Array<[string, string, string]> = [
    ['element access with a string key', "export class P { constructor(private prisma: any) {} f() { return this.prisma['communityMessage'].findMany({}); } }", 'CommunityMessage'],
    ['element access with a string constant', "const model = 'communityMessage'; export const f = (prisma: any) => prisma[model].findMany({});", 'CommunityMessage'],
    ['a destructured delegate', 'export class P { constructor(private prisma: any) {} f() { const { communityPost } = this.prisma; return communityPost.findMany({}); } }', 'CommunityPost'],
    ['a renamed destructured delegate', 'export const f = (prisma: any) => { const { communityMessage: rows } = prisma; return rows.findMany({}); };', 'CommunityMessage'],
    ['an alias from a receiver not named like a client', 'export class P { constructor(private deps: any) {} f() { const d = this.deps.communityWin; return d.findMany({}); } }', 'CommunityWin'],
    ['a bound read method', 'export const f = (prisma: any) => prisma.communityMessage.findMany.bind(prisma.communityMessage)({});', 'CommunityMessage'],
    ['a delegate named in a string for a generic reader', "export class P { a() { return this.all('communityResponse'); } all(m: string) { return m; } }", 'CommunityResponse'],
    ['an include held in a constant', 'const INC = { community_messages_sent: true } as const;\nexport const f = (prisma: any) => prisma.user.findMany({ include: INC });', 'CommunityMessage'],
    ['an include with a computed constant key', "const field = 'community_messages_sent'; export const f = (prisma: any) => prisma.user.findMany({ include: { [field]: true } });", 'CommunityMessage'],
    ['a fluent relation read', 'export const f = (prisma: any, id: string) => prisma.user.findUnique({ where: { id } }).community_messages_sent();', 'CommunityMessage'],
    ['raw SQL on a schema-qualified table', 'export const f = (prisma: any) => prisma.$queryRaw`SELECT m.body FROM "public"."community_messages" m`;', 'CommunityMessage'],
    ['raw SQL with the table in a FROM list', 'export const f = (prisma: any) => prisma.$queryRaw`SELECT m.body FROM users u, community_messages m WHERE m.sender_id = u.id`;', 'CommunityMessage'],
    ['a dynamic delegate key (fails closed)', 'export const f = (prisma: any, model: string) => prisma[model].findMany({});', ANY_MODEL],
    ['a dynamic delegate on db (fails closed)', 'export const f = (db: any, model: string) => db[model];', ANY_MODEL],
    ['a Prisma.raw table name (fails closed)', "import { Prisma } from '@prisma/client'; export const f = (prisma: any, t: string) => prisma.$queryRaw`SELECT * FROM ${Prisma.raw(t)}`;", ANY_MODEL],
    ['concatenated SQL for $queryRawUnsafe (fails closed)', "export const f = (prisma: any, t: string) => prisma.$queryRawUnsafe('SELECT * FROM ' + t);", ANY_MODEL],
    // FR-1185R2 class 2 (LS-1185R2 B2): a read whose model or table cannot be named yields '*'.
    ['a dynamic table after an unquoted schema (fails closed)', "import { Prisma } from '@prisma/client'; export const f = (prisma: any, t: string) => prisma.$queryRaw`SELECT * FROM public.${Prisma.raw(t)}`;", ANY_MODEL],
    ['a dynamic table after a quoted schema (fails closed)', "import { Prisma } from '@prisma/client'; export const f = (prisma: any, t: string) => prisma.$queryRaw`SELECT * FROM \"public\".${Prisma.raw(t)} m`;", ANY_MODEL],
    ['a quoted dynamic table after a schema in a JOIN (fails closed)', "import { Prisma } from '@prisma/client'; export const f = (prisma: any, t: string) => prisma.$queryRaw`SELECT 1 FROM users u JOIN \"public\".\"${Prisma.raw(t)}\" m ON TRUE`;", ANY_MODEL],
    ['a dynamic table in a FROM list (fails closed)', "import { Prisma } from '@prisma/client'; export const f = (prisma: any, t: string) => prisma.$queryRaw`SELECT 1 FROM users u, ${Prisma.raw(t)} m`;", ANY_MODEL],
    ['an include constant with a runtime computed key (fails closed)', 'export const f = (prisma: any, relation: string) => { const include = { [relation]: true }; return prisma.user.findMany({ include }); };', ANY_MODEL],
    ['a select constant with a runtime computed key (fails closed)', 'export const f = (prisma: any, relation: string) => { const select = { id: true, [relation]: true }; return prisma.user.findMany({ select }); };', ANY_MODEL],
    ['an include from a parameter (fails closed)', 'export const f = (prisma: any, include: object) => prisma.user.findMany({ include });', ANY_MODEL],
    ['an include constant changed later (fails closed)', "export const f = (prisma: any, k: string) => { const include: Record<string, boolean> = {}; include[k] = true; return prisma.user.findMany({ include }); };", ANY_MODEL],
    ['an include spread from a constant', 'const BASE = { community_messages_sent: true }; export const f = (prisma: any) => prisma.user.findMany({ include: { ...BASE } });', 'CommunityMessage'],
    ['an include chosen by ?:', 'const WITH = { community_messages_sent: true }; export const f = (prisma: any, x: boolean) => prisma.user.findMany({ include: x ? WITH : {} });', 'CommunityMessage'],
    ['an include built by a function', 'const inc = () => ({ community_messages_sent: true }); export const f = (prisma: any) => prisma.user.findMany({ include: inc() });', 'CommunityMessage'],
    ['a select held in a constant', 'const SELECT = { id: true, community_posts_authored: { select: { body: true } } }; export const f = (prisma: any) => prisma.user.findMany({ select: SELECT });', 'CommunityPost'],
  ];
  it.each(FORMS)('the scan reports %s', (_form, source, model) => {
    const root = mkdtempSync(join(tmpdir(), 'kt2-form-'));
    try {
      writeFileSync(join(root, 'probe.ts'), source);
      expect(scanMemberContentReads(root).map((s) => s.model)).toContain(model);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the scan reports a new caller of a repository reader as a read of that reader (LO-1185 B3)', () => {
    const root = mkdtempSync(join(tmpdir(), 'kt2-caller-'));
    try {
      mkdirSync(join(root, 'community', 'messages'), { recursive: true });
      copyFileSync(
        join(REPO_ROOT, 'src/community/messages/community-messages.repository.ts'),
        join(root, 'community/messages/community-messages.repository.ts'),
      );
      writeFileSync(
        join(root, 'community/messages/space-digest.service.ts'),
        [
          "import { CommunityMessagesRepository } from './community-messages.repository';",
          'export class SpaceDigestService {',
          '  constructor(private readonly repo: CommunityMessagesRepository) {}',
          '  latest(cohortId: string) { return this.repo.listCohortMessages({ cohortId, before: null, limit: 20 }); }',
          '}',
        ].join('\n'),
      );
      const found = scanMemberContentReads(root)
        .filter((s) => s.via === 'caller' && s.file.endsWith('space-digest.service.ts'))
        .map((s) => `${s.reader} ${s.model} ${s.callee}`);
      expect(found).toEqual(['SpaceDigestService.latest CommunityMessage CommunityMessagesRepository.listCohortMessages']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // FR-1185R2 class 1 (LS-1185R2 B1, LO-1185R2 B2, C1, C2): a caller of a reader that leaves the rules to its caller
  // is a read site, in any form. Each row adds one caller file next to a copy of the real messages repository; the
  // caller sites outside the repository must be exactly these (callee `?.name` with '*': fails closed).
  const LC = 'CommunityMessagesRepository.listCohortMessages';
  const IMPORT = "import { CommunityMessagesRepository } from './community-messages.repository';";
  const ARGS = '{ cohortId: c, before: null, limit: 20 }';
  const held = (body: string, type = 'CommunityMessagesRepository') =>
    `${IMPORT}\nexport class S {\n  constructor(private readonly repo: ${type}) {}\n  ${body}\n}\n`;
  const CALLER_FORMS: Array<[string, string, string[], ScanOptions?]> = [
    ['a property typed by the repository', held(`m(c: string) { return this.repo.listCohortMessages(${ARGS}); }`), [`S.m CommunityMessage ${LC}`]],
    ['an import alias', held(`m(c: string) { return this.repo.listCohortMessages(${ARGS}); }`, 'MessagesRepo').replace(IMPORT, "import { CommunityMessagesRepository as MessagesRepo } from './community-messages.repository';"), [`S.m CommunityMessage ${LC}`]],
    ['a statically named element call', held(`m(c: string) { return this.repo['listCohortMessages'](${ARGS}); }`), [`S.m CommunityMessage ${LC}`]],
    ['an element call with a string constant', `const NAME = 'listCohortMessages';\n${held(`m(c: string) { return this.repo[NAME](${ARGS}); }`)}`, [`S.m CommunityMessage ${LC}`]],
    ['a getter that returns the repository', held(`get r() { return this.repo; }\n  m(c: string) { return this.r.listCohortMessages(${ARGS}); }`), [`S.m CommunityMessage ${LC}`]],
    ['an untyped local alias', held(`m(c: string) { const r = this.repo; return r.listCohortMessages(${ARGS}); }`), [`S.m CommunityMessage ${LC}`]],
    ['a destructure of this', held(`m(c: string) { const { repo } = this; return repo.listCohortMessages(${ARGS}); }`), [`S.m CommunityMessage ${LC}`]],
    ['a destructured method', held(`m(c: string) { const { listCohortMessages } = this.repo; return listCohortMessages.call(this.repo, ${ARGS}); }`), [`S.m CommunityMessage ${LC}`]],
    ['a .call', held(`m(c: string) { return this.repo.listCohortMessages.call(this.repo, ${ARGS}); }`), [`S.m CommunityMessage ${LC}`]],
    ['a .bind', held(`m(c: string) { const f = this.repo.listCohortMessages.bind(this.repo); return f(${ARGS}); }`), [`S.m CommunityMessage ${LC}`]],
    ['a typed parameter of a function', `${IMPORT}\nexport function latest(repo: CommunityMessagesRepository, c: string) { return repo.listCohortMessages(${ARGS}); }\n`, [`latest CommunityMessage ${LC}`]],
    ['an interface the repository fits', `interface Lister { listCohortMessages(...args: never[]): unknown }\n${held(`m(c: string) { return this.repo.listCohortMessages(${ARGS}); }`, 'Lister')}`, [`S.m CommunityMessage ${LC}`]],
    ['an abstract member the repository fits', `export abstract class Lister { abstract listCohortMessages(...args: never[]): unknown; }\n${held(`m(c: string) { return this.repo.listCohortMessages(${ARGS}); }`, 'Lister')}`, [`S.m CommunityMessage ${LC}`]],
    ['a subclass', `${IMPORT}\nexport class Mine extends CommunityMessagesRepository {\n  m(c: string) { return this.listCohortMessages(${ARGS}); }\n}\n`, [`Mine.m CommunityMessage ${LC}`]],
    ['a repository wrapper in another repository, then its caller (fixed point)',
      `${IMPORT}\nexport class DigestRepository {\n  constructor(private readonly messages: CommunityMessagesRepository) {}\n  page(c: string) { return this.messages.listCohortMessages(${ARGS}); }\n}\n` +
      'export class DigestService {\n  constructor(private readonly digest: DigestRepository) {}\n  m() { return this.digest.page(\'c\'); }\n}\n',
      [`DigestRepository.page CommunityMessage ${LC}`, 'DigestService.m CommunityMessage DigestRepository.page']],
    ['a same-class repository wrapper, then its caller (LO-1185R2 B2)',
      `${IMPORT}\nexport class DigestRepository extends CommunityMessagesRepository {\n  page(c: string) { return this.listCohortMessages(${ARGS}); }\n}\n` +
      'export class DigestService {\n  constructor(private readonly digest: DigestRepository) {}\n  m() { return this.digest.page(\'c\'); }\n}\n',
      [`DigestRepository.page CommunityMessage ${LC}`, 'DigestService.m CommunityMessage DigestRepository.page']],
    ['a declared pass-through outside a repository, then its callers (LO-1185R2 C1)',
      held(`private rows(c: string) { return this.repo.listCohortMessages(${ARGS}); }\n  forCoach(c: string) { return this.rows(c); }\n  forClient(c: string) { return this.rows(c); }`),
      [`S.rows CommunityMessage ${LC}`, 'S.forCoach CommunityMessage S.rows', 'S.forClient CommunityMessage S.rows'], { passThrough: ['S.rows'] }],
    ['a value typed any, called by a reader\'s name (fails closed)', `export function latest(repo: any, c: string) { return repo.listCohortMessages(${ARGS}); }\n`, ['latest * ?.listCohortMessages']],
    ['a computed key on the repository (fails closed)', held('m(k: keyof CommunityMessagesRepository) { return this.repo[k]; }'), ['S.m * ?.[key]']],
  ];
  /** Caller sites outside the copied repository, for these caller files. */
  const callerSites = (files: Record<string, string>, options?: ScanOptions): string[] => {
    const root = mkdtempSync(join(tmpdir(), 'kt2-callers-'));
    try {
      mkdirSync(join(root, 'community', 'messages'), { recursive: true });
      copyFileSync(
        join(REPO_ROOT, 'src/community/messages/community-messages.repository.ts'),
        join(root, 'community/messages/community-messages.repository.ts'),
      );
      for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'community/messages', name), text);
      const found = scanMemberContentReads(root, options)
        .filter((s) => s.via === 'caller' && !s.file.endsWith('community-messages.repository.ts'))
        .map((s) => `${s.reader} ${s.model} ${s.callee}`);
      return [...new Set(found)].sort();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  it.each(CALLER_FORMS)('the scan reports a caller through %s', (_form, source, expected, options) => {
    expect(callerSites({ 'caller.ts': source }, options)).toEqual([...expected].sort());
  });

  // The scan limits (member-content-scan.ts header, L1 to L5): each test shows what the scan still cannot see, so
  // closing a limit turns its test red and the header must change with it.
  it('limit L1: a reader called on a value typed by a package (unresolved, not any) is not seen', () => {
    const source = `${IMPORT}\nimport { ModuleRef } from '@nestjs/core';\nexport class S {\n  constructor(private readonly refs: ModuleRef) {}\n` +
      `  m(c: string) { return this.refs.get(CommunityMessagesRepository).listCohortMessages(${ARGS}); }\n}\n`;
    expect(callerSites({ 'caller.ts': source })).toEqual([]);
  });
  it('limit L2: a reader named only at runtime (Reflect.get with its name) is not seen', () => {
    expect(callerSites({ 'caller.ts': held(`m(c: string) { return Reflect.get(this.repo, 'listCohortMessages').call(this.repo, ${ARGS}); }`) })).toEqual([]);
  });
  it('limit L3: a pass-through outside a repository is followed only when its row declares callers', () => {
    const source = held(`private rows(c: string) { return this.repo.listCohortMessages(${ARGS}); }\n  forCoach(c: string) { return this.rows(c); }`);
    expect(callerSites({ 'caller.ts': source })).toEqual([`S.rows CommunityMessage ${LC}`]);
  });
  it('limit L4: rows kept in a field and read by another method are not traced', () => {
    const source = held(`private cached: unknown;\n  async load(c: string) { this.cached = await this.repo.listCohortMessages(${ARGS}); }\n  show() { return this.cached; }`);
    expect(callerSites({ 'caller.ts': source })).toEqual([`S.load CommunityMessage ${LC}`]);
  });
  it('limit L5: SQL split across a string concatenation outside an Unsafe call is matched piece by piece', () => {
    const root = mkdtempSync(join(tmpdir(), 'kt2-limit-'));
    try {
      writeFileSync(join(root, 'probe.ts'), "export const SQL = 'SELECT m.body FROM community_' + 'messages m';\n");
      expect(scanMemberContentReads(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    expect([...vias].sort()).toEqual(['aliased', 'caller', 'dynamic', 'prisma', 'relation', 'sql']);
    expect(new Set(sites.map((s) => s.model).filter((m) => m !== ANY_MODEL)).size).toBe(Object.keys(MEMBER_CONTENT_MODELS).length);
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
  {
    // LS-1185 B2: the single-target reaction summary (CommunityReactionsService.visibleReactions, private).
    name: 'one item reaction summary',
    file: 'src/community/reactions/community-reactions.repository.ts',
    reader: 'CommunityReactionsRepository.listForTarget',
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
    read: (w) => {
      const repo = new CommunityReactionsRepository(stub<ConstructorParameters<typeof CommunityReactionsRepository>[0]>(w.db));
      const service = Object.assign(Object.create(CommunityReactionsService.prototype), { reactions: repo, safety: w.safety });
      return service.visibleReactions(w.viewer, { workspaceId: w.wsId, targetType: 'post', targetId: w.postId });
    },
    shows: 'count',
    count: (out) => (Array.isArray(out) ? out.length : 0),
  },
];

function stub<T>(v: unknown): T {
  return v as T;
}

describe('KT-2 behavior: the registered readers that run in memory honor all four rules', () => {
  it('every behavior row matches its registry row, both ways', () => {
    const cases: Array<{ name: string; file: string; reader: string }> = [...BEHAVIOR_READS, ...COACH_READS];
    const named = new Set(cases.map((b) => readerKey(b.file, b.reader)));
    const problems = [
      ...cases.filter((b) => registry.get(readerKey(b.file, b.reader))?.behavior !== b.name).map(
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
        // LS-1185 C1: the title names the registry row it checks.
        const title = gap
          ? `${key}: KNOWN GAP (KT-2): an author ${rule} still shows (registry: ${decided})`
          : `${key}: an author ${rule}: no words, no row, no name, not counted; the control member still shows`;
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

describe('KT-2 behavior: the coaching-chat readers, with the coach as the viewer', () => {
  for (const c of COACH_READS) {
    const key = readerKey(c.file, c.reader);
    const row = registry.get(key);
    describe(c.name, () => {
      for (const rule of c.runs) {
        const decided = row?.[RULE_COLUMN[rule]] ?? '';
        const gap = isGap(decided);
        const title = gap
          ? `${key}: KNOWN GAP (KT-2): a client ${rule} still counts (registry: ${decided})`
          : `${key}: a client ${rule} is not counted; the control client still is`;
        it(title, async () => {
          const { before, after } = await runCoachCase(c, rule);
          // Both clients count before the rule, so a reader that sees nothing is never a vacuous pass.
          expect(before).toBe(2);
          if (!gap) {
            expect(after).toBe(1);
          } else if (after === 1) {
            throw new Error(
              `KNOWN GAP fixed: ${key} now leaves out a client ${rule}. Replace its "GAP:" text in ` +
                'test/community/access/member-content-readers.ts with how the rule is applied now (KT-2).',
            );
          } else {
            expect(after).toBe(2);
          }
        });
      }
      it(`${key}: the rules not run here say why (${c.notRun})`, () => {
        expect(c.notRun.trim()).not.toBe('');
      });
    });
  }
});

async function runCoachCase(c: CoachRead, rule: AccessRule): Promise<{ before: number; after: number }> {
  const w = await accessWorld();
  const author = w.member('Hidden Client');
  const messageId = seedCoachMessage(w, author, c.voice === true);
  seedCoachMessage(w, w.control, c.voice === true);
  const before = await c.count(w, author);
  await applyCoachRule(w, rule, author, messageId);
  return { before, after: await c.count(w, author) };
}

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
