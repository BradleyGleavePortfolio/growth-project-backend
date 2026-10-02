/**
 * Build Week Day 1 copy points to the consultation, not the switched-off
 * diagnostic quiz (B-QUIZ-OFF follow-up, operator 112 2026-10-02 13:27).
 *
 * Two places carry the catalog copy and must agree:
 *   - prisma/seed-build-week.json (source of truth for the catalog text);
 *   - the loaded BuildWeekDay rows, changed only by migrations
 *     (20260506020000_add_build_week loaded them; 20270224000000 rewrites Day 1).
 *
 * This spec pins: the seed's new Day 1 copy and that nothing else in the seed
 * changed; that the data migration is scoped to day_number = 1, does no DDL
 * and touches no other table; that its guards match the originally loaded
 * text exactly (so it really applies) and its new values equal the seed (so
 * database and seed say the same thing); that it is idempotent by
 * construction (every UPDATE guarded by the old value); and that down.sql is
 * the exact inverse. Real-Postgres execution of migration.sql (with its
 * fail-closed post-condition) happens in CI: Schema parity applies the full
 * chain, and the migration dry run applies forward, down, forward again.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const DIR = 'prisma/migrations/20270224000000_build_week_day1_consultation_copy';
const MIGRATION = read(`${DIR}/migration.sql`);
const DOWN = read(`${DIR}/down.sql`);
const ORIGINAL_LOAD = read('prisma/migrations/20260506020000_add_build_week/migration.sql');

type ActionItem = { title: string; description: string; time_estimate_min: number };
type Day = {
  day_number: number;
  title: string;
  focus_area: string;
  narrative: string;
  prompt_questions: string[];
  action_items: ActionItem[];
  expected_artifact: string;
};
const SEED = JSON.parse(read('prisma/seed-build-week.json')) as Day[];
const DAY1 = SEED.find((d) => d.day_number === 1) as Day;

const OLD = {
  itemTitle: 'Complete the 40-point diagnostic',
  itemDescription:
    'Work through the diagnostic form end-to-end. Honest answers only — this becomes the baseline every later week is measured against.',
  focus: 'Diagnostic + Baseline',
  narrativeSentence:
    'The 40-point diagnostic, the starting body weight, and the income baseline together form the snapshot',
  artifact: 'Diagnostic + baseline snapshot: weight, income, hours, and a 100-word success statement.',
};
const NEW = {
  itemTitle: 'Complete your consultation',
  itemDescription:
    'Work through your consultation in the app from start to finish so your coach can tailor your plan. Honest answers only. This becomes the baseline every later week is measured against.',
  focus: 'Consultation + Baseline',
  narrativeSentence:
    'Your consultation, the starting body weight, and the income baseline together form the snapshot',
  artifact: 'Consultation + baseline snapshot: weight, income, hours, and a 100-word success statement.',
};

/** The original Day 1 narrative as loaded by 20260506020000 (single-quoted SQL literal). */
function originalDay1Narrative(): string {
  const m = ORIGINAL_LOAD.match(/VALUES \(gen_random_uuid\(\), 1, 'Audit', '[^']*', '((?:[^']|'')*)'/);
  if (!m) throw new Error('Day 1 INSERT not found in 20260506020000_add_build_week');
  return m[1].replace(/''/g, "'");
}

/** SQL statements without comments (the DO block counts as one statement). */
function statements(sql: string): string[] {
  const noComments = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  const out: string[] = [];
  let buf = '';
  let inDollar = false;
  for (const line of noComments.split('\n')) {
    buf += `${line}\n`;
    if ((line.match(/\$\$/g) ?? []).length % 2 === 1) inDollar = !inDollar;
    if (!inDollar && line.trim().endsWith(';')) {
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

describe('Build Week Day 1 copy points to the consultation (seed)', () => {
  it('Day 1 names the consultation and no longer the diagnostic quiz', () => {
    expect(DAY1.focus_area).toBe(NEW.focus);
    expect(DAY1.expected_artifact).toBe(NEW.artifact);
    expect(DAY1.narrative).toContain(NEW.narrativeSentence);
    expect(DAY1.action_items[0]).toEqual({
      title: NEW.itemTitle,
      description: NEW.itemDescription,
      time_estimate_min: 25,
    });
    expect(JSON.stringify(DAY1)).not.toMatch(/diagnostic/i);
  });

  it('no other Build Week text in the seed names the diagnostic', () => {
    expect(JSON.stringify(SEED)).not.toMatch(/diagnostic/i);
  });

  it('nothing else in the seed changed (days 2-7 and the rest of Day 1 pinned to main)', () => {
    expect(SEED).toHaveLength(7);
    expect(sha(JSON.stringify(SEED.slice(1)))).toBe('ab77c33371553b5fa29b88db484b1d1d3724d69ce39190d6dded9b4fb11112aa');
    const keep = {
      day_number: DAY1.day_number,
      title: DAY1.title,
      prompt_questions: DAY1.prompt_questions,
      others: DAY1.action_items.slice(1),
    };
    expect(sha(JSON.stringify(keep))).toBe('713dc2010ba6f76251959b1ef0a23b76b83c74a4e16292704adda7539a63361d');
    expect(DAY1.narrative).toBe(originalDay1Narrative().replace(OLD.narrativeSentence, NEW.narrativeSentence));
  });

  it('copy rules: no exclamation marks, no emoji, no medical claims', () => {
    const day1 = JSON.stringify(DAY1);
    expect(day1).not.toMatch(/!/);
    expect(day1).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(day1).not.toMatch(/diagnos|treat|cure|medical/i);
  });
});

describe('20270224000000_build_week_day1_consultation_copy (data migration)', () => {
  const stmts = statements(MIGRATION);
  const updates = stmts.filter((s) => /^UPDATE\b/i.test(s));

  it('takes prefix 20270224000000 (operator-assigned), unique, after the catalog load', () => {
    const dirs = readdirSync(join(ROOT, 'prisma', 'migrations'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
      .map((e) => e.name)
      .sort();
    const name = DIR.split('/').pop() as string;
    expect(name.slice(0, 14)).toBe('20270224000000');
    expect(dirs.filter((d) => d.startsWith('20270224000000'))).toEqual([name]);
    expect(dirs.indexOf(name)).toBeGreaterThan(dirs.indexOf('20260506020000_add_build_week'));
  });

  it('is data only: four guarded UPDATEs of "BuildWeekDay" day_number = 1 plus a post-condition, no DDL, no other table', () => {
    expect(updates).toHaveLength(4);
    expect(stmts).toHaveLength(5);
    expect(stmts[4]).toMatch(/^DO \$\$/);
    for (const u of updates) {
      expect(u).toMatch(/^UPDATE "BuildWeekDay"( AS d)?\s/);
      expect(u).toMatch(/WHERE (d\.)?"day_number" = 1\s/);
    }
    const all = stmts.join('\n');
    expect(all).not.toMatch(/\b(INSERT|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/i);
    const tables = [...all.matchAll(/"([A-Z][A-Za-z]+)"/g)].map((m) => m[1]);
    expect(new Set(tables)).toEqual(new Set(['BuildWeekDay']));
  });

  it('every UPDATE is guarded by the old value (idempotent: a second run matches no row)', () => {
    expect(updates[0]).toContain(`WHERE e.elem ->> 'title' = '${OLD.itemTitle}'`);
    expect(updates[1]).toContain(`AND "focus_area" = '${OLD.focus}'`);
    expect(updates[2]).toContain(`strpos("narrative", '${OLD.narrativeSentence}') > 0`);
    expect(updates[3]).toContain(`AND "expected_artifact" = '${OLD.artifact}'`);
    // The new values never satisfy the guards, so a re-run is a no-op.
    expect(NEW.itemTitle).not.toBe(OLD.itemTitle);
    expect(NEW.focus).not.toBe(OLD.focus);
    expect(NEW.narrativeSentence).not.toContain(OLD.narrativeSentence);
    expect(NEW.artifact).not.toBe(OLD.artifact);
  });

  it('its guards match the text 20260506020000 actually loaded (so it applies)', () => {
    const day1Insert = ORIGINAL_LOAD.split('\n').find((l) => /VALUES \(gen_random_uuid\(\), 1, 'Audit'/.test(l)) ?? '';
    expect(day1Insert).toContain(`'${OLD.focus}'`);
    expect(day1Insert).toContain(OLD.narrativeSentence);
    expect(day1Insert).toContain(`"title": "${OLD.itemTitle}"`);
    expect(day1Insert).toContain(`'${OLD.artifact}'`);
  });

  it('its new values equal the seed (database and seed say the same thing)', () => {
    expect(updates[0]).toContain(`'title', '${DAY1.action_items[0].title}'`);
    expect(updates[0]).toContain(`'description', '${DAY1.action_items[0].description}'`);
    expect(updates[0]).toContain(`'time_estimate_min', t.elem -> 'time_estimate_min'`);
    expect(updates[0]).toMatch(/ORDER BY t\.ord/);
    expect(updates[1]).toContain(`SET "focus_area" = '${DAY1.focus_area}'`);
    expect(updates[2]).toContain(`'${NEW.narrativeSentence}'`);
    expect(updates[3]).toContain(`SET "expected_artifact" = '${DAY1.expected_artifact}'`);
  });

  it('fails closed if Day 1 still names the diagnostic after the update', () => {
    expect(stmts[4]).toMatch(/WHERE "day_number" = 1/);
    expect(stmts[4]).toMatch(/RAISE EXCEPTION/);
    for (const col of ['"action_items"::text', '"focus_area"', '"narrative"', '"expected_artifact"']) {
      expect(stmts[4]).toContain(col);
    }
  });

  it('down.sql is the exact inverse, guarded by the new values, scoped to Day 1', () => {
    const down = statements(DOWN);
    expect(down).toHaveLength(4);
    for (const u of down) expect(u).toMatch(/WHERE (d\.)?"day_number" = 1\s/);
    expect(down.join('\n')).not.toMatch(/\b(INSERT|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
    expect(down[0]).toContain(`WHERE e.elem ->> 'title' = '${NEW.itemTitle}'`);
    expect(down[0]).toContain(`'title', '${OLD.itemTitle}'`);
    expect(down[0]).toContain(`'description', '${OLD.itemDescription}'`);
    expect(down[1]).toContain(`SET "focus_area" = '${OLD.focus}'`);
    expect(down[1]).toContain(`AND "focus_area" = '${NEW.focus}'`);
    expect(down[2]).toContain(`strpos("narrative", '${NEW.narrativeSentence}') > 0`);
    expect(down[3]).toContain(`SET "expected_artifact" = '${OLD.artifact}'`);
    expect(down[3]).toContain(`AND "expected_artifact" = '${NEW.artifact}'`);
    // The restored action item is byte-for-byte the originally loaded one.
    expect(ORIGINAL_LOAD).toContain(
      `{"title": "${OLD.itemTitle}", "description": "${OLD.itemDescription.replace('—', '\\u2014')}", "time_estimate_min": 25}`,
    );
  });
});
