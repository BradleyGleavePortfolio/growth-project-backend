/**
 * FR-1185R2 class 3 (LO-1185R2 B1): the in-memory double (test/community/safety/in-memory-prisma.ts) applies only the
 * rules the SQL asks for. Three parts, each table-driven over RAW_SQL_BRANCHES, the double's list of every $queryRaw
 * branch with the predicates it reads from `asks`:
 *   1. the list is the dispatch: $queryRaw answers only through it, and each branch's answer reads exactly the
 *      predicates it lists (a branch that reads one more, or applies a rule it does not read, turns this red);
 *   2. per branch, SQL of its shape that names no rule leaves every ban, block, removal and departure unapplied, and
 *      SQL that names one predicate applies that rule and only it;
 *   3. the removal sweep: for each reader the double answers, each access predicate cut from the SQL the real reader
 *      sends (the test copy of its query) turns that reader's check red, and the untouched query keeps it green.
 * FR-1185R3 class 3 (LS-1185R3 B3): the double reads only the active SQL (activeSql). A predicate or a marker inside
 * a comment (line, block, nested block) or a string literal ('...', E'...', $$...$$, $tag$...$tag$) is not asked
 * for: table-tested on every branch and predicate, and the sweep comments out (and quotes) each predicate of each
 * real reader's SQL as well as cutting it, each turning that reader's check red.
 * Not here: SQL the double does not answer (community-space-reads.service.ts, community-search.repository.ts and the
 * rule D report readers' joins) runs on Postgres under row security in test/rls (community-space-reads-rls,
 * community-moved-client-rls, community-rule-d-readers-rls); the double refuses SQL no branch knows.
 */
import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { authorsWhoLeft, rowsByAuthorsWhoStay, spacesOpenTo } from '../../../src/community/community-space-access';
import { unbannedSpaces } from '../../../src/community/community-public-row';
import type { PrismaService } from '../../../src/prisma.service';
import { activeSql, InMemoryPrisma, RAW_SQL_ASKS, RAW_SQL_BRANCHES, type RawSqlAsk, type Row } from '../safety/in-memory-prisma';
import { accessWorld, type AccessWorld } from './member-content-fixture';
import { REPO_ROOT } from './member-content-scan';

type User = ReturnType<AccessWorld['member']>;

function stub<T>(v: unknown): T {
  return v as T;
}

/** Text the next raw() call appends to its SQL: a predicate the branch does not read, so the double sees its name. */
let unread = '';

/** A tagged-template call with these string parts (what a `$queryRaw\`...\`` call hands the double). */
function raw(db: InMemoryPrisma, parts: string[], ...values: unknown[]): Promise<Row[]> {
  const sql = [...parts];
  sql[sql.length - 1] += unread;
  return db.$queryRaw(Object.assign(sql, { raw: [...sql] }), ...values);
}

const on = (names: readonly RawSqlAsk[], k: RawSqlAsk, text: string): string => (names.includes(k) ? text : '');

/** The predicate as a query writes it, in SQL that runs. */
const active = (k: RawSqlAsk): string => (k === 'live' ? RAW_SQL_ASKS[k] : `${RAW_SQL_ASKS[k]}(t."w", t."a")`);

/** LS-1185R3 B3: every way SQL text can sit in a query without running (Postgres comments and string literals). */
const INACTIVE: Array<[string, (text: string) => string]> = [
  ['a line comment', (t) => `\n  -- AND ${t}\n`],
  ['a line comment that ends the query', (t) => ` -- AND ${t}`],
  ['a block comment', (t) => ` /* AND ${t} */`],
  ['a nested block comment', (t) => ` /* off /* AND ${t} */ still off */`],
  ['a string literal', (t) => ` AND 'x' <> 'AND ${t.split("'").join("''")}'`],
  ['an E string with an escaped quote', (t) => ` AND E'it\\'s AND ${t}' IS NOT NULL`],
  ['a dollar-quoted string', (t) => ` AND $$AND ${t}$$ IS NOT NULL`],
  ['a tagged dollar-quoted string', (t) => ` AND $q$AND ${t}$q$ IS NOT NULL`],
];

/** A world with one author who wrote one live message in the space, in good standing until `hit`. */
async function world(): Promise<{ w: AccessWorld; a: User; messageId: string }> {
  const w = await accessWorld();
  const a = w.member('Rule Author');
  const m = w.db.seed('communityMessage', {
    workspace_id: w.wsId, cohort_id: w.cohortId, sender_id: a.id, scope: 'cohort', body: 'hello', deleted_at: null,
  });
  return { w, a, messageId: m.id as string };
}

/** Put the author under the rule each predicate names. */
async function hit(w: AccessWorld, a: User, messageId: string, k: RawSqlAsk): Promise<void> {
  switch (k) {
    case 'stays':
      return w.apply('departed (moved to another coach)', a);
    case 'unbanned':
    case 'access':
      return w.apply('banned from the community', a);
    case 'block':
      return w.apply('blocked by the viewer', a);
    case 'live':
      // A removed row: its author left too, so only the removal decides whether the pair is listed.
      await w.apply('departed (moved to another coach)', a);
      return w.apply('removed or deleted', a, { table: 'communityMessage', id: messageId });
  }
}

interface Shape {
  /** SQL of the branch's shape that names exactly `names` (beside the marker), run on the double. */
  run(w: AccessWorld, a: User, names: readonly RawSqlAsk[]): Promise<Row[]>;
  /** The answer when no rule applies. */
  plain(w: AccessWorld, a: User): Row[];
  /** The answer when the rule `k` applies to the author. */
  ruled(w: AccessWorld, a: User, k: RawSqlAsk): Row[];
  /** The predicates every query of this shape must name (its marker is a predicate, or it needs one to list). */
  always?: readonly RawSqlAsk[];
}

const SHAPES: Record<string, Shape> = {
  'WITH t AS MATERIALIZED': {
    run: (w, a, n) => raw(w.db, [
      `WITH t AS MATERIALIZED (SELECT "workspace_id" AS "w", "cohort_id" AS "s", "sender_id" AS "a" FROM "community_messages"
        WHERE "cohort_id" = ANY(`, `::uuid[]) ${on(n, 'live', 'AND "deleted_at" IS NULL')}
        UNION SELECT "workspace_id", "cohort_id", "author_id" FROM "community_posts" WHERE "cohort_id" = ANY(`, `::uuid[]))
      SELECT t."s"::text AS "s", t."a" FROM t WHERE FALSE
        ${on(n, 'stays', 'OR NOT app.community_author_stays(t."w", t."s", t."a")')}
        ${on(n, 'unbanned', 'OR NOT app.community_author_unbanned(t."w", t."a")')}
        OR (${n.includes('block') ? 'app.users_in_block(' : 'FALSE AND ('}`, `::text, t."a"))`,
    ], [w.cohortId], [w.cohortId], w.viewer.id),
    plain: () => [],
    ruled: (w, a, k) => (k === 'live' ? [] : [{ s: w.cohortId, a: a.id }]),
  },
  'AS t("id", "w")': {
    run: (w, a, n) => raw(w.db, [
      `SELECT t."id"::text AS "id" FROM unnest(`, `::uuid[], `, `::uuid[]) AS t("id", "w")
       WHERE ${n.includes('unbanned') ? 'app.community_author_unbanned(t."w", ' : '(TRUE OR '}`, `::text IS NULL)`,
    ], [w.cohortId], [w.wsId], a.id),
    plain: (w) => [{ id: w.cohortId }],
    ruled: () => [],
  },
  '"community_moderation_actions" a': {
    run: (w) => raw(w.db, [`SELECT a."id" FROM "community_moderation_actions" a WHERE a."workspace_id" = `, `::uuid`], w.wsId),
    plain: () => [],
    ruled: () => [],
  },
  'WITH ORDINALITY': {
    run: (w, a, n) => raw(w.db, [
      `SELECT (t."n" - 1)::int AS "n" FROM unnest(`, `::uuid[], `, `::text[], `, `::text[]) WITH ORDINALITY AS t("w", "s", "a", "n")
       WHERE TRUE ${on(n, 'stays', 'AND app.community_author_stays(t."w", NULLIF(t."s", \'\')::uuid, t."a")')}
         ${on(n, 'unbanned', 'AND app.community_author_unbanned(t."w", t."a")')}`,
    ], [w.wsId], [w.cohortId], [a.id]),
    plain: () => [{ n: 0 }],
    ruled: () => [],
  },
  'app.community_can_access': {
    run: (w, a, n) => raw(w.db, [
      `SELECT t."c"::text || ':' || t."u" AS "k" FROM unnest(`, `::uuid[], `, `::text[]) AS t("c", "u")
       WHERE ${n.includes('access') ? 'app.community_can_access(t."c", t."u", ' : '(TRUE OR '}`, `::boolean)`,
    ], [w.cohortId], [a.id], false),
    plain: (w, a) => [{ k: `${w.cohortId}:${a.id}` }],
    ruled: () => [],
    always: ['access'],
  },
};

const RULES = Object.keys(RAW_SQL_ASKS) as RawSqlAsk[];

describe('FR-1185R2 class 3: every $queryRaw branch of the double, with the predicates it reads', () => {
  it('$queryRaw answers only through RAW_SQL_BRANCHES and hands each branch only the predicates it lists', () => {
    const src = readFileSync(join(REPO_ROOT, 'test/community/safety/in-memory-prisma.ts'), 'utf8');
    const body = src.slice(src.indexOf('async $queryRaw('), src.indexOf('async $transaction<'));
    // LS-1185R3 B3: the marker and the predicates are read in the active SQL only (no comment, no string literal).
    expect(body).toContain('const sql = activeSql(strings);');
    expect(body).toContain('RAW_SQL_BRANCHES.find((b) => sql.includes(b.marker))');
    expect(body).toContain('for (const k of hit.reads) asks[k] = sql.includes(RAW_SQL_ASKS[k]);');
    // No branch outside the table: the method body names no SQL text of its own.
    expect(body.match(/sql\.includes\('/g) ?? []).toEqual([]);
    for (const b of RAW_SQL_BRANCHES) {
      const read = [...new Set(b.answer.toString().match(/asks\.(\w+)/g) ?? [])].map((m) => m.slice(5)).sort();
      expect({ reader: b.reader, reads: read }).toEqual({ reader: b.reader, reads: [...b.reads].sort() });
    }
  });

  it('every branch has a shape here, and no shape names a branch the double does not have', () => {
    expect(RAW_SQL_BRANCHES.map((b) => b.marker).sort()).toEqual(Object.keys(SHAPES).sort());
  });

  describe.each(RAW_SQL_BRANCHES.map((b) => [b.reader, b] as const))('%s', (_reader, b) => {
    const shape = SHAPES[b.marker];
    const always = shape.always ?? [];

    it('SQL that names no rule leaves every ban, block, removal and departure unapplied', async () => {
      const { w, a, messageId } = await world();
      for (const k of RULES) if (!always.includes(k)) await hit(w, a, messageId, k);
      if (always.length > 0) {
        // Its marker is the rule: without it no branch answers, so the double refuses rather than apply it.
        await expect(shape.run(w, a, [])).rejects.toThrow('unsupported $queryRaw');
        return;
      }
      expect(await shape.run(w, a, [])).toEqual(shape.plain(w, a));
    });

    it.each(RULES.map((k) => [k] as const))('the rule named by %s', async (k) => {
      const reads = b.reads.includes(k);
      const { w, a, messageId } = await world();
      // Control first: named, with the author in good standing.
      const named = [...new Set([...always, ...(k === 'live' ? ['stays' as const] : []), k])].filter((n) => b.reads.includes(n) || n === k);
      if (!reads) {
        // A predicate the branch does not read: naming it or not, the rule never applies here.
        await hit(w, a, messageId, k);
        const without = await shape.run(w, a, named.filter((n) => n !== k)).catch((e: Error) => e.message);
        // Named in active SQL (a comment would not name it at all, LS-1185R3 B3), where it cannot change the answer.
        unread = ` AND (TRUE OR ${active(k)})`;
        const withIt = await shape.run(w, a, named.filter((n) => n !== k)).catch((e: Error) => e.message).finally(() => {
          unread = '';
        });
        expect(withIt).toEqual(without);
        return;
      }
      expect(await shape.run(w, a, named)).toEqual(shape.plain(w, a));
      await hit(w, a, messageId, k);
      expect(await shape.run(w, a, named)).toEqual(shape.ruled(w, a, k));
      if (always.includes(k)) return;
      // The same SQL without it: the rule is not applied.
      const rest = named.filter((n) => n !== k);
      expect(await shape.run(w, a, rest)).toEqual(k === 'live' ? [{ s: w.cohortId, a: a.id }] : shape.plain(w, a));
    });
  });
});

describe('FR-1185R3 class 3: the double reads only the active SQL (LS-1185R3 B3)', () => {
  it.each(INACTIVE)('activeSql drops text in %s and keeps the SQL around it', (_form, wrap) => {
    for (const k of RULES) {
      const sql = activeSql([`SELECT "deleted_at" FROM t WHERE "a--b" = 1${wrap(active(k))}\n  AND "w" = `, '::uuid']);
      expect(sql).not.toContain(RAW_SQL_ASKS[k]);
      expect(sql).toContain('SELECT "deleted_at" FROM t WHERE "a--b" = 1');
      expect(sql).toContain('AND "w" = ');
    }
    // Control: the same predicate in active SQL is kept.
    expect(activeSql([`SELECT 1 WHERE ${active('unbanned')}`])).toContain(RAW_SQL_ASKS.unbanned);
  });

  describe.each(RAW_SQL_BRANCHES.map((b) => [b.reader, b] as const))('%s', (_reader, b) => {
    const shape = SHAPES[b.marker];
    const always = shape.always ?? [];

    it.each(INACTIVE)('its marker only in %s answers nothing: the double refuses the SQL', async (_form, wrap) => {
      const { w } = await world();
      await expect(raw(w.db, [`SELECT 1 FROM unnest(`, `::uuid[])${wrap(b.marker)}`], [w.cohortId])).rejects.toThrow('unsupported $queryRaw');
    });

    const cases = b.reads.flatMap((k) => INACTIVE.map(([form, wrap]) => [`${k} only in ${form}`, k, wrap] as const));
    if (cases.length === 0) {
      it('reads no predicate, so no inactive form can change its answer', () => expect(b.reads).toEqual([]));
      return;
    }
    it.each(cases)('%s is not applied', async (_name, k, wrap) => {
      const { w, a, messageId } = await world();
      await hit(w, a, messageId, k);
      const named = [...new Set([...always, ...(k === 'live' ? ['stays' as const] : []), k])].filter((n) => b.reads.includes(n));
      const rest = named.filter((n) => n !== k);
      // Control: named in active SQL, the rule applies.
      expect(await shape.run(w, a, named)).toEqual(shape.ruled(w, a, k));
      const without = await shape.run(w, a, rest).catch((e: Error) => e.message);
      unread = wrap(active(k));
      const inactive = await shape.run(w, a, rest).catch((e: Error) => e.message).finally(() => {
        unread = '';
      });
      expect(inactive).toEqual(without);
      if (always.includes(k)) expect(inactive).toContain('unsupported $queryRaw');
      else expect(inactive).not.toEqual(shape.ruled(w, a, k));
    });
  });
});

const escapeRe = (text: string): string => text.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');

/** How the sweep takes `name` out of a real reader's SQL: renamed, commented out (line or block), or quoted. */
const CUTS: Array<[string, (part: string, name: string) => string]> = [
  ['cut', (part, name) => part.split(name).join('app.kt2_predicate_cut')],
  // From the predicate to the end of its line (past a ${} on that line, as Postgres reads a line comment).
  ['line-commented', (part, name) => part.replace(new RegExp(`${escapeRe(name)}[^\n]*`, 'g'), (m) => `-- ${m}`)],
  ['block-commented', (part, name) => part.split(name).join(`/* ${name} */`)],
  ['quoted as a string', (part, name) => part.split(name).join(`'${name.split("'").join("''")}'`)],
];

/** Take `k`'s predicate out of every SQL text the double is handed while `run` runs; returns how many texts held it. */
async function withCut<T>(
  k: RawSqlAsk,
  run: () => Promise<T>,
  how: (part: string, name: string) => string = CUTS[0][1],
): Promise<{ out: T | Error; cut: number }> {
  const original = InMemoryPrisma.prototype.$queryRaw;
  const name = RAW_SQL_ASKS[k];
  let cut = 0;
  InMemoryPrisma.prototype.$queryRaw = function (this: InMemoryPrisma, strings: TemplateStringsArray, ...values: unknown[]) {
    if (!strings.join('').includes(name)) return original.call(this, strings, ...values);
    cut += 1;
    const copy = strings.map((s) => how(s, name));
    return original.call(this, Object.assign(copy, { raw: copy }), ...values);
  };
  try {
    return { out: await run().catch((e: Error) => e), cut };
  } finally {
    InMemoryPrisma.prototype.$queryRaw = original;
  }
}

interface SweepRow {
  reader: string;
  /** The source file whose SQL holds the predicate (checked, so the sweep follows the real query). */
  file: string;
  predicate: RawSqlAsk;
  /** True when the reader applies the rule to the author under it. */
  check(w: AccessWorld, a: User): Promise<boolean>;
}

const db = (w: AccessWorld) => stub<PrismaService>(w.db);
const stayCheck = async (w: AccessWorld, a: User) =>
  (await rowsByAuthorsWhoStay(db(w), w.viewer.id, [{ id: 'row', a: a.id }], (r) => r.a, () => [w.wsId, w.cohortId] as const)).length === 0;
const leftCheck = async (w: AccessWorld, a: User) =>
  (await authorsWhoLeft(db(w), [w.cohortId], w.viewer.id)).some(([s, x]) => s === w.cohortId && x === a.id);

const SWEEP: SweepRow[] = [
  { reader: 'rowsByAuthorsWhoStay', file: 'src/community/community-space-access.ts', predicate: 'stays', check: stayCheck },
  { reader: 'rowsByAuthorsWhoStay', file: 'src/community/community-space-access.ts', predicate: 'unbanned', check: stayCheck },
  { reader: 'authorsWhoLeft', file: 'src/community/community-space-access.ts', predicate: 'stays', check: leftCheck },
  { reader: 'authorsWhoLeft', file: 'src/community/community-space-access.ts', predicate: 'unbanned', check: leftCheck },
  { reader: 'authorsWhoLeft', file: 'src/community/community-space-access.ts', predicate: 'block', check: leftCheck },
  {
    reader: 'authorsWhoLeft', file: 'src/community/community-space-access.ts', predicate: 'live',
    // A removed row is not listed (its author left, but the row no longer reads anywhere).
    check: async (w, a) => !(await leftCheck(w, a)),
  },
  {
    reader: 'unbannedSpaces', file: 'src/community/community-public-row.ts', predicate: 'unbanned',
    check: async (w, a) => (await unbannedSpaces(db(w), a.id, [{ id: w.cohortId, workspace_id: w.wsId }])).length === 0,
  },
  {
    reader: 'spacesOpenTo', file: 'src/community/community-space-access.ts', predicate: 'access',
    check: async (w, a) => !(await spacesOpenTo(db(w), [[w.cohortId, a.id]])).has(`${w.cohortId}:${a.id}`),
  },
];

describe('FR-1185R2 class 3: removal sweep, each access predicate cut from the real reader\'s SQL turns its check red', () => {
  it('the sweep covers every predicate of every branch with a src reader', () => {
    const swept = new Set(SWEEP.map((s) => `${s.reader} ${s.predicate}`));
    const expected = RAW_SQL_BRANCHES.filter((b) => b.reads.length > 0)
      .flatMap((b) => b.reads.map((k) => `${b.reader.split(' ')[0]} ${k}`));
    expect([...swept].sort()).toEqual(expected.sort());
  });

  const rows = SWEEP.flatMap((s) => CUTS.map(([how, fn]) => [`${s.reader} with ${RAW_SQL_ASKS[s.predicate]} ${how}`, s, fn] as const));
  it.each(rows)('%s', async (_name, s, how) => {
    expect(readFileSync(join(REPO_ROOT, s.file), 'utf8')).toContain(RAW_SQL_ASKS[s.predicate]);
    const { w, a, messageId } = await world();
    await hit(w, a, messageId, s.predicate);
    // Green: the reader as written applies the rule.
    expect(await s.check(w, a)).toBe(true);
    // Red: the same reader with the predicate cut from its SQL, commented out or quoted no longer applies it (or
    // the double refuses the SQL).
    const { out, cut } = await withCut(s.predicate, () => s.check(w, a), how);
    expect(cut).toBeGreaterThan(0);
    expect(out === true).toBe(false);
  });
});
