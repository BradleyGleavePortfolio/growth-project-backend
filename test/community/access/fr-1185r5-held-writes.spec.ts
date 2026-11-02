/**
 * FR-1185R5 class tests (owner #192-D3 op 2; LS-1185R6 B1 and B2 are two members of each class).
 *
 * B1, writes to a held value: the follow pass counts every write that can change a held where, select, include,
 * orderBy or count argument: a field or property of the held value set or reassigned later (`this.where.x = ...`,
 * `this.where = {...}`, `holder.where.x = ...`, `holder.where = {...}`), Object.assign, Object.defineProperty,
 * Object.defineProperties, Reflect.set, and a call that receives the held value. A call whose body the checker
 * cannot read (a declaration only, a library function) may write what it is handed: it fails closed ('*').
 *
 * B2, how a read is called: the follow pass enters for every form the direct visitor and the caller resolver accept
 * as a read (`d['findMany']`, `d[METHOD]`, a destructured or aliased method, `.call`, `.apply`, `.bind`), through
 * one entry rule; an invocation it cannot read (`.apply` with a list it cannot follow, the method handed on) fails
 * closed.
 *
 * Each form holds a relation into members' content on a model that can reach it (User): it is a read of the
 * function that makes the call. The same shapes on a model that cannot reach members' content (BuildWeekEnrollment)
 * stay quiet. The real gate: unregistered, the read is red; registered with all four rules decided, green; with the
 * ban rule skipped, red. Test-only; no runtime changes.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProbeCopy } from './ls-1185-probe-copy';
import { ANY_MODEL, scanMemberContentReads } from './member-content-scan';

/** A member-content relation filter on User (its posts), held apart from the where. */
const AUTHORED = 'const authored = { some: { body: { contains: "query" } } };';
const HELD = `${AUTHORED} const where = { community_posts_authored: authored };`;
/** The same shapes on BuildWeekEnrollment, which cannot reach members' content. */
const DONE = 'const done = { some: { day: 1 } };';
const QUIET_HELD = `${DONE} const where = { completions: done };`;

type Form = [name: string, source: string, reader: string];

/** B1: a write to the held value after it is made. */
const writes: Form[] = [
  ['a class field given a key by a helper method', `${AUTHORED}
    export class HeldReader {
      private where: Record<string, unknown> = {};
      private configure() { this.where.community_posts_authored = authored; }
      read(p: any) { this.configure(); return p.user.findMany({ where: this.where }); }
    }`, 'HeldReader.read'],
  ['a class field reassigned in the constructor', `${AUTHORED}
    export class HeldReader {
      private where: Record<string, unknown> = {};
      constructor() { this.where = { community_posts_authored: authored }; }
      read(p: any) { return p.user.findMany({ where: this.where }); }
    }`, 'HeldReader.read'],
  ['a class field set through a literal element key', `${AUTHORED}
    export class HeldReader {
      private where: Record<string, unknown> = {};
      read(p: any) { this['where'] = { community_posts_authored: authored }; return p.user.findMany({ where: this.where }); }
    }`, 'HeldReader.read'],
  ['a holder property given a key', `${AUTHORED}
    export function read(p: any) {
      const holder = { where: {} as Record<string, unknown> };
      holder.where.community_posts_authored = authored;
      return p.user.findMany({ where: holder.where });
    }`, 'read'],
  ['a holder property reassigned', `${AUTHORED}
    export function read(p: any) {
      const holder: { where: object } = { where: {} };
      holder.where = { community_posts_authored: authored };
      return p.user.findMany({ where: holder.where });
    }`, 'read'],
  ['Object.assign into a class field', `${AUTHORED}
    export class HeldReader {
      private where: Record<string, unknown> = {};
      read(p: any) { Object.assign(this.where, { community_posts_authored: authored }); return p.user.findMany({ where: this.where }); }
    }`, 'HeldReader.read'],
  ['Object.assign into the holder of the held property', `${AUTHORED}
    export function read(p: any) {
      const holder: { where: object } = { where: {} };
      const filters = { community_posts_authored: authored };
      Object.assign(holder, { where: filters });
      return p.user.findMany({ where: holder.where });
    }`, 'read'],
  ['Object.defineProperty with a constant key', `${AUTHORED} const KEY = 'community_posts_authored';
    export function read(p: any) {
      const where = {};
      Object.defineProperty(where, KEY, { value: authored, enumerable: true });
      return p.user.findMany({ where });
    }`, 'read'],
  ['Object.defineProperties on a class field', `${AUTHORED}
    export class HeldReader {
      private where = {};
      read(p: any) {
        Object.defineProperties(this.where, { community_posts_authored: { value: authored, enumerable: true } });
        return p.user.findMany({ where: this.where });
      }
    }`, 'HeldReader.read'],
  ['Reflect.set on a holder property', `${AUTHORED}
    export function read(p: any) {
      const holder = { where: {} };
      Reflect.set(holder.where, 'community_posts_authored', authored);
      return p.user.findMany({ where: holder.where });
    }`, 'read'],
  ['the held value handed to a helper through .call', `${AUTHORED}
    function addAuthored(w: Record<string, unknown>) { w.community_posts_authored = authored; }
    export function read(p: any) {
      const where: Record<string, unknown> = {};
      addAuthored.call(null, where);
      return p.user.findMany({ where });
    }`, 'read'],
];

/** B2: every way a read method is named and invoked. */
const invocations: Form[] = [
  ['a literal element key', `${HELD} export const read = (p: any) => p.user['findMany']({ where });`, 'read'],
  ['a constant element key', `${HELD} const METHOD = 'count'; export const read = (p: any) => p.user[METHOD]({ where });`, 'read'],
  ['a destructured method', `${HELD} export function read(p: any) { const { findMany } = p.user; return findMany({ where }); }`, 'read'],
  ['a destructured and renamed method', `${HELD} export function read(p: any) { const { findFirst: first } = p.user; return first({ where }); }`, 'read'],
  ['an aliased method', `${HELD} export function read(p: any) { const list = p.user.findMany; return list({ where }); }`, 'read'],
  ['.call', `${HELD} export const read = (p: any) => p.user.findMany.call(p.user, { where });`, 'read'],
  ['.apply', `${HELD} export const read = (p: any) => p.user.aggregate.apply(p.user, [{ where }]);`, 'read'],
  ['.bind, then called', `${HELD} export function read(p: any) { const list = p.user.findMany.bind(p.user); return list({ where }); }`, 'read'],
  ['.bind with the argument bound', `${HELD} export const read = (p: any) => p.user.findMany.bind(p.user, { where })();`, 'read'],
  ['an aliased method invoked with .call', `${HELD} export function read(p: any) { const { groupBy } = p.user; return groupBy.call(p.user, { by: ['id'], where }); }`, 'read'],
];

/** Forms the checker cannot follow on a model that can reach members' content: FAIL CLOSED. */
const unfollowable: Form[] = [
  ['the held where handed to a declared function without a body', `${AUTHORED}
    declare function addFilters(w: object): void;
    export function read(p: any) { const where = { role: 'student' }; addFilters(where); return p.user.findMany({ where }); }`, 'read'],
  ['the held where handed to an interface method', `
    interface Filters { fill(w: object): void }
    export function read(p: any, f: Filters) { const where = { role: 'student' }; f.fill(where); return p.user.findMany({ where }); }`, 'read'],
  ['the held where handed to a library call', `
    export function read(p: any, extra: object) {
      const where = { role: 'student' };
      Object.setPrototypeOf(where, extra);
      return p.user.findMany({ where });
    }`, 'read'],
  ['a class field handed to a package helper', `import { addFilters } from 'some-package';
    export class HeldReader {
      private where = { role: 'student' };
      read(p: any) { addFilters(this.where); return p.user.findMany({ where: this.where }); }
    }`, 'HeldReader.read'],
  ['Object.defineProperty with a key it cannot name', `
    export function read(p: any, key: string, v: object) {
      const where = {};
      Object.defineProperty(where, key, { value: v });
      return p.user.findMany({ where });
    }`, 'read'],
  ['Reflect.set with a key it cannot name', `
    export function read(p: any, key: string, v: object) {
      const where = {};
      Reflect.set(where, key, v);
      return p.user.findMany({ where });
    }`, 'read'],
  ['.apply with an argument list it cannot follow', 'export const read = (p: any, args: any[]) => p.user.findMany.apply(p.user, args);', 'read'],
  ['a read method handed on as a reference', `
    declare function run(f: unknown): unknown;
    export const read = (p: any) => run(p.user.findMany);`, 'read'],
];

/** The same shapes on BuildWeekEnrollment (no path to members' content), and controls that are not reads. */
const quiet: Array<[name: string, source: string]> = [
  ['a class field given a key by a helper method', `${DONE}
    export class HeldReader {
      private where: Record<string, unknown> = {};
      private configure() { this.where.completions = done; }
      read(p: any) { this.configure(); return p.buildWeekEnrollment.findMany({ where: this.where }); }
    }`],
  ['a holder property reassigned', `${DONE}
    export function read(p: any) {
      const holder: { where: object } = { where: {} };
      holder.where = { completions: done };
      return p.buildWeekEnrollment.findMany({ where: holder.where });
    }`],
  ['Object.defineProperty, Object.defineProperties and Reflect.set', `${DONE}
    export function read(p: any) {
      const where = {};
      Object.defineProperty(where, 'completions', { value: done });
      Object.defineProperties(where, { completions: { value: done } });
      Reflect.set(where, 'completions', done);
      return p.buildWeekEnrollment.findMany({ where });
    }`],
  ['the held where handed to a library call and a declared function', `${QUIET_HELD}
    declare function addFilters(w: object): void;
    export function read(p: any, extra: object) {
      Object.setPrototypeOf(where, extra);
      addFilters(where);
      return p.buildWeekEnrollment.findMany({ where });
    }`],
  ['a literal key, a destructured method, .call, .apply and .bind', `${QUIET_HELD}
    export function read(p: any) {
      const { findMany } = p.buildWeekEnrollment;
      const list = p.buildWeekEnrollment.count.bind(p.buildWeekEnrollment);
      return [p.buildWeekEnrollment['findMany']({ where }), findMany({ where }), list({ where }),
        p.buildWeekEnrollment.findMany.call(p.buildWeekEnrollment, { where }),
        p.buildWeekEnrollment.findMany.apply(p.buildWeekEnrollment, [{ where }])];
    }`],
  ['a count read off a result, not a read method', `
    export async function read(p: any) {
      const { _count: counts } = await p.buildWeekEnrollment.aggregate({ _count: { id: true } });
      const { count } = counts;
      return count + 1;
    }`],
  ['a method of the scanned code named like a read, called on this', `${HELD}
    export class Local {
      findMany(arg: object) { return arg; }
      read() { const m = this['findMany']; return [this.findMany({ where }), m.call(this, { where })]; }
    }`],
];

function scan(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'fr1185r5-held-'));
  try {
    writeFileSync(join(root, 'probe.ts'), source);
    return scanMemberContentReads(root).map((s) => `${s.reader} ${s.model}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('FR-1185R5 B1: a write to a held argument is followed, or fails closed', () => {
  it.each(writes)('%s is a read of the function that makes the call', (_name, source, reader) => {
    expect(scan(source)).toContain(`${reader} CommunityPost`);
  });
});

describe('FR-1185R5 B2: every invocation form of a read enters the follow pass', () => {
  it.each(invocations)('%s is a read of the function that makes the call', (_name, source, reader) => {
    expect(scan(source)).toContain(`${reader} CommunityPost`);
  });
  it('the dotted call stays a read (control)', () => {
    expect(scan(`${HELD} export const read = (p: any) => p.user.findMany({ where });`)).toContain('read CommunityPost');
  });
});

describe('FR-1185R5: what the follow pass cannot read fails closed on a model that can reach members\' content', () => {
  it.each(unfollowable)('%s fails closed', (_name, source, reader) => {
    expect(scan(source)).toContain(`${reader} ${ANY_MODEL}`);
  });
});

describe('FR-1185R5: the same shapes on a model that cannot reach members\' content', () => {
  it.each(quiet)('%s stays quiet', (_name, source) => {
    expect(scan(source)).toEqual([]);
  });
});

describe('FR-1185R5: the real gate on a held field written by a helper and a read invoked through .bind', () => {
  const READER = `import type { Prisma, PrismaClient } from '@prisma/client';
    const authored: Prisma.CommunityPostListRelationFilter = { some: { body: { contains: 'query' } } };
    export class HeldFieldReader {
      private where: Prisma.UserWhereInput = {};
      private configure() { Reflect.set(this.where, 'community_posts_authored', authored); }
      read(prisma: PrismaClient) {
        this.configure();
        const list = prisma.user.findMany.bind(prisma.user);
        return list({ where: this.where });
      }
    }`;
  const ROW = (ban: string) => `  r('fr-1185r5-reader.ts', 'HeldFieldReader.read', ['CommunityPost'], 'shown', 'probe: members by a post they wrote', {
    block: 'filterBlocked on the authors', ban: ${JSON.stringify(ban)}, removed: 'deleted_at: null on the post',
    departed: 'authorsWhoLeft on the authors' }),\n`;
  function gate(row?: string) {
    const root = createProbeCopy();
    const scratch = mkdtempSync(join(tmpdir(), 'fr1185r5-gate-'));
    const report = join(scratch, 'result.json');
    try {
      writeFileSync(join(root, 'src/fr-1185r5-reader.ts'), READER);
      if (row !== undefined) {
        const registry = join(root, 'test/community/access/member-content-readers.ts');
        const text = readFileSync(registry, 'utf8');
        writeFileSync(registry, text.replace('const ROWS: RegisteredReader[] = [\n', `const ROWS: RegisteredReader[] = [\n${row}`));
      }
      const run = spawnSync(process.execPath, [
        require.resolve('jest/bin/jest'), '--runInBand', '--no-cache', '--json', `--outputFile=${report}`,
        '--testNamePattern=finds no unregistered read|all four rules decided',
        'test/community/access/member-content-access.spec.ts',
      ], { cwd: root, encoding: 'utf8', timeout: 110000, maxBuffer: 1024 * 1024 * 8 });
      if (run.error) throw run.error;
      const result = JSON.parse(readFileSync(report, 'utf8')) as {
        testResults: Array<{ assertionResults: Array<{ title: string; status: string }> }>;
      };
      const status = Object.fromEntries(result.testResults.flatMap((t) => t.assertionResults.map((a) => [a.title, a.status])));
      return { status, output: `${run.stdout}\n${run.stderr}` };
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it('unregistered, the read turns the gate red', () => {
    const { status, output } = gate();
    expect(status['finds no unregistered read']).toBe('failed');
    expect(output).toContain('HeldFieldReader.read reads CommunityPost');
  }, 120000);

  it('registered with block, ban, removal and departure decided, the same read is green', () => {
    const { status } = gate(ROW('filterBlocked with the space as place (app.community_author_unbanned)'));
    expect(status['finds no unregistered read']).toBe('passed');
    expect(status['lists each reader once, with known models and all four rules decided']).toBe('passed');
  }, 120000);

  it('registered with the ban rule skipped, the same read is red', () => {
    const { status, output } = gate(ROW(''));
    expect(status['lists each reader once, with known models and all four rules decided']).toBe('failed');
    expect(output).toContain('HeldFieldReader.read: the ban rule is not decided');
  }, 120000);
});
