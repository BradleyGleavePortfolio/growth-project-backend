/**
 * Roman v1.1 R11-P3b-1: playbook source collector.
 *
 * Pins the slice contract: only the team's own rows are read (head coach plus
 * active sub-coaches, never another coach); messages, session notes and
 * client-bound guidelines or meal plans come only from clients holding the
 * 'memory' scope; every string is roster-scrubbed; per-item and total caps;
 * the ledger digest is order-free; no model call and no writes.
 *
 * The Prisma fake evaluates the collector's real `where` / `orderBy` / `take`
 * against seeded rows, so a missing tenancy or consent filter shows up as a
 * leaked row.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaService } from '../../src/prisma.service';
import type { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import type { AiEgressService } from '../../src/ai-egress/ai-egress.service';
import type { PlaybookSignalsService } from '../../src/roman/playbook/playbook-signals.service';
import {
  PLAYBOOK_SOURCE_LIMITS,
  PlaybookSourceCollector,
  playbookLedgerDigest,
} from '../../src/roman/playbook/playbook-sources';

type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const v = row[k];
    if (cond === null) {
      if (v !== null && v !== undefined) return false;
      continue;
    }
    if (cond instanceof Date || typeof cond !== 'object') {
      if (v instanceof Date && cond instanceof Date ? v.getTime() !== cond.getTime() : v !== cond) return false;
      continue;
    }
    if ('in' in cond && !(cond.in as unknown[]).includes(v)) return false;
    if ('not' in cond && cond.not === null && (v === null || v === undefined)) return false;
    if ('gte' in cond && !(v >= cond.gte)) return false;
    if ('lte' in cond && !(v <= cond.lte)) return false;
  }
  return true;
}

function fakePrisma(tables: Record<string, Row[]>) {
  const calls: Record<string, Row[]> = {};
  const models: Row = {};
  for (const name of [
    'teamSubCoachAssignment',
    'user',
    'coachGuideline',
    'workoutProgram',
    'workoutPlan',
    'mealPlan',
    'coachingSession',
    'coachMessage',
    'exerciseCatalogItem',
  ]) {
    models[name] = {
      findMany: jest.fn(async (args: Row = {}) => {
        (calls[name] ??= []).push(args);
        const rows = (tables[name] ?? []).filter((r) => matches(r, args.where));
        return typeof args.take === 'number' ? rows.slice(0, args.take) : rows;
      }),
    };
  }
  return { prisma: Object.assign(Object.create(null) as PrismaService, models), calls };
}

const H = 'coach-head-7f3a';
const S = 'coach-sub-91bd';
const X = 'coach-sub-archived-0c44';
const O = 'coach-other-55e1';
const C1 = 'client-aa11'; // H, memory scope
const C2 = 'client-bb22'; // H, base scope only
const C3 = 'client-cc33'; // S, memory scope
const OC = 'client-oo01'; // O, memory scope
const NOW = new Date('2026-10-07T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const SIGNALS = { version: 'pbs-v1', team_size: 2 };

function tables(over: Record<string, Row[]> = {}): Record<string, Row[]> {
  const msg = (id: string, coach: string, sender: string, client: string, body: string, at = daysAgo(3), deleted: Date | null = null) =>
    ({ id, coach_id: coach, sender_id: sender, client_id: client, body, created_at: at, deleted_at: deleted });
  return {
    teamSubCoachAssignment: [
      { head_coach_id: H, sub_coach_id: S, archived_at: null },
      { head_coach_id: H, sub_coach_id: X, archived_at: daysAgo(10) },
      { head_coach_id: O, sub_coach_id: 'coach-sub-of-o', archived_at: null },
    ],
    user: [
      { id: C1, coach_id: H, role: 'student', deletion_scheduled_at: null, deleted_at: null, name: 'Zelda Quill', leaderboard_display_name: 'ZQ Lifts', email: 'zelda@example.com', phone: '+1 415 555 0101' },
      { id: C2, coach_id: H, role: 'student', deletion_scheduled_at: null, deleted_at: null, name: 'Marcus Fenwick', leaderboard_display_name: null, email: 'marcus@example.com', phone: null },
      { id: C3, coach_id: S, role: 'student', deletion_scheduled_at: null, deleted_at: null, name: 'Priya Okonkwo', leaderboard_display_name: null, email: 'priya@example.com', phone: null },
      { id: OC, coach_id: O, role: 'student', deletion_scheduled_at: null, deleted_at: null, name: 'Olive Stranger', leaderboard_display_name: null, email: 'olive@example.com', phone: null },
      { id: S, coach_id: null, role: 'coach', deletion_scheduled_at: null, deleted_at: null, name: 'Samira Coachwell', leaderboard_display_name: null, email: 'samira@example.com', phone: null },
    ],
    coachGuideline: [
      { id: 'g-wide', coach_id: H, client_id: null, content: 'Always a 10 minute warm up. Protein at every meal.' },
      { id: 'g-c1', coach_id: H, client_id: C1, content: 'Zelda Quill: box squats instead of back squats until the knee settles.' },
      { id: 'g-c2', coach_id: H, client_id: C2, content: 'Marcus secret guideline about his shoulder.' },
      { id: 'g-o', coach_id: O, client_id: null, content: 'Other coach guideline.' },
    ],
    workoutProgram: [
      { id: 'tpl-h', owner_user_id: S, is_template: true, archived_at: null, name: 'Strength Base', description: 'Linear progression, RPE 7-8.', weeks: 8, days_per_week: 4 },
      { id: 'tpl-o', owner_user_id: O, is_template: true, archived_at: null, name: 'Other Template', description: null, weeks: 4, days_per_week: 3 },
    ],
    workoutPlan: [
      { id: 'plan-h', coach_id: H, archived_at: null, is_template: false, program_id: null, name: 'Push Day', exercises: [{ exercise_external_id: 'ex-bench' }, { exercise_external_id: 'ex-unknown' }] },
      { id: 'plan-clone', coach_id: H, archived_at: null, is_template: false, program_id: 'prog-c1', name: 'Zelda copy day', exercises: [] },
      { id: 'plan-o', coach_id: O, archived_at: null, is_template: false, program_id: null, name: 'Other Plan', exercises: [] },
    ],
    exerciseCatalogItem: [{ id: 'ex-bench', slug: 'barbell-bench-press', source_ref: null, name: 'Barbell Bench Press' }],
    mealPlan: [
      { id: 'mp-wide', coach_id: H, client_id: null, archived_at: null, title: 'High protein base', notes: 'Four meals, carbs around training.' },
      { id: 'mp-c1', coach_id: H, client_id: C1, archived_at: null, title: 'Cut for Zelda', notes: null },
      { id: 'mp-c2', coach_id: H, client_id: C2, archived_at: null, title: 'Marcus private plan', notes: 'secret' },
      { id: 'mp-o', coach_id: O, client_id: null, archived_at: null, title: 'Other meal plan', notes: null },
    ],
    coachingSession: [
      { id: 'sn-c1', coach_id: H, client_id: C1, start_at: daysAgo(5), coach_notes_md: 'Zelda said the knee hurts, call 415-555-0101 on 2026-10-01.' },
      { id: 'sn-c1-old', coach_id: H, client_id: C1, start_at: daysAgo(200), coach_notes_md: 'Old note.' },
      { id: 'sn-c2', coach_id: H, client_id: C2, start_at: daysAgo(5), coach_notes_md: 'Marcus private note.' },
      { id: 'sn-o', coach_id: O, client_id: OC, start_at: daysAgo(5), coach_notes_md: 'Other coach note.' },
    ],
    coachMessage: [
      msg('m-c1', H, H, C1, 'Great work Zelda, add 5 lb next week.'),
      msg('m-c1-client', H, C1, C1, 'Thanks coach, my knee is sore.'),
      msg('m-c2', H, H, C2, 'Marcus, private message.'),
      msg('m-c3', S, S, C3, 'Priya, sleep 8 hours before heavy days.'),
      msg('m-deleted', H, H, C1, 'Deleted message.', daysAgo(2), daysAgo(1)),
      msg('m-old', H, H, C1, 'Old message.', daysAgo(100)),
      msg('m-o', O, O, OC, 'Other coach message.'),
    ],
    ...over,
  };
}

function collector(t: Record<string, Row[]>, memory: readonly string[] = [C1, C3, OC]) {
  const { prisma, calls } = fakePrisma(t);
  const budget = { resolveHeadCoachId: jest.fn(async (id: string) => (id === S ? H : id)) };
  const egress = {
    consentedClients: jest.fn(async (ids: readonly string[], scope: string) =>
      new Set(scope === 'memory' ? ids.filter((id) => memory.includes(id)) : ids)),
  };
  const signals = { compute: jest.fn(async () => SIGNALS) };
  const svc = new PlaybookSourceCollector(
    prisma,
    Object.assign(Object.create(null) as CoachAIBudgetService, budget),
    Object.assign(Object.create(null) as AiEgressService, egress),
    Object.assign(Object.create(null) as PlaybookSignalsService, signals),
  );
  return { svc, calls, egress, signals };
}

const ids = (out: { ledger: readonly { source_id: string }[] }) => out.ledger.map((r) => r.source_id).sort();

describe('R11-P3b-1 playbook sources: tenancy', () => {
  it('reads only the team (head + active sub-coaches); another coach’s rows never appear', async () => {
    const { svc, calls } = collector(tables());
    const out = await svc.collect(H, NOW);
    expect(out.headCoachId).toBe(H);
    for (const id of ['g-o', 'tpl-o', 'plan-o', 'mp-o', 'sn-o', 'm-o']) expect(ids(out)).not.toContain(id);
    expect(calls.coachMessage[0].where.coach_id).toEqual({ in: [H, S] });
    expect(calls.coachingSession[0].where.coach_id).toEqual({ in: [H, S] });
    expect(calls.workoutProgram[0].where.owner_user_id).toEqual({ in: [H, S] });
    expect(JSON.stringify(out.items)).not.toMatch(/Other|Olive/);
  });

  it('folds a sub-coach into its head coach', async () => {
    const { svc, signals } = collector(tables());
    const out = await svc.collect(S, NOW);
    expect(out.headCoachId).toBe(H);
    expect(signals.compute).toHaveBeenCalledWith(H, { clientIds: [C1, C3], now: NOW });
  });

  it('skips cloned client program days, a client’s own messages, deleted and out-of-window rows', async () => {
    const out = await collector(tables()).svc.collect(H, NOW);
    for (const id of ['plan-clone', 'm-c1-client', 'm-deleted', 'm-old', 'sn-c1-old']) expect(ids(out)).not.toContain(id);
    expect(out.items.find((i) => i.id === 'plan-h')?.text).toBe('Push Day: Barbell Bench Press');
  });
});

describe('R11-P3b-1 playbook sources: memory-scope consent', () => {
  it('uses only memory-scope clients for messages, notes and client-bound guidelines or meal plans', async () => {
    const { svc, egress } = collector(tables());
    const out = await svc.collect(H, NOW);
    expect(egress.consentedClients).toHaveBeenCalledWith([C1, C2, C3], 'memory');
    expect(out.consentedClientIds).toEqual([C1, C3]);
    expect(ids(out)).toEqual(['g-c1', 'g-wide', 'm-c1', 'm-c3', 'mp-c1', 'mp-wide', 'plan-h', 'sn-c1', 'tpl-h']);
    expect(JSON.stringify(out.items)).not.toMatch(/Marcus|secret|private/);
    expect(out.ledger).toContainEqual({ source_kind: 'session_note', source_id: 'sn-c1', client_id: C1 });
    expect(out.ledger).toContainEqual({ source_kind: 'guideline', source_id: 'g-wide' });
    expect(out.items.filter((i) => i.private).map((i) => i.id).sort()).toEqual(['m-c1', 'm-c3', 'sn-c1']);
  });

  it('with no memory-scope client: no message or note query, coach-authored items only', async () => {
    const { svc, calls, signals } = collector(tables(), []);
    const out = await svc.collect(H, NOW);
    expect(calls.coachMessage).toBeUndefined();
    expect(calls.coachingSession).toBeUndefined();
    expect(ids(out)).toEqual(['g-wide', 'mp-wide', 'plan-h', 'tpl-h']);
    expect(out.ledger.every((r) => r.client_id === undefined)).toBe(true);
    expect(out.items.every((i) => !i.private)).toBe(true);
    expect(signals.compute).toHaveBeenCalledWith(H, { clientIds: [], now: NOW });
  });
});

describe('R11-P3b-1 playbook sources: scrub and caps', () => {
  it('scrubs roster names, display names, sub-coach names, phones and dates', async () => {
    const out = await collector(tables()).svc.collect(H, NOW);
    const json = JSON.stringify(out.items);
    for (const s of ['Zelda', 'Quill', 'Priya', 'Samira', 'ZQ Lifts', '555', '2026-10-01']) expect(json).not.toContain(s);
    expect(out.items.find((i) => i.id === 'sn-c1')?.text).toBe('[NAME] said the knee hurts, call [PHONE] on [DATE].');
  });

  it('caps each item at 600 characters, the total at 40,000, and passes the row caps', async () => {
    const long = Array.from({ length: 100 }, (_, i) => ({ id: `g-${i}`, coach_id: H, client_id: null, content: `${'squat deep '.repeat(80)}${i}` }));
    const { svc, calls } = collector(tables({ coachGuideline: long }));
    const out = await svc.collect(H, NOW);
    expect(out.items.every((i) => i.text.length <= PLAYBOOK_SOURCE_LIMITS.itemChars)).toBe(true);
    expect(out.items.reduce((n, i) => n + i.text.length, 0)).toBeLessThanOrEqual(PLAYBOOK_SOURCE_LIMITS.totalChars);
    expect(out.items.length).toBe(out.ledger.length);
    expect(out.items.length).toBeLessThan(100);
    expect(calls.coachMessage[0].take).toBe(150);
    expect(calls.coachingSession[0].take).toBe(80);
    expect(calls.coachMessage[0].where.created_at.gte).toEqual(daysAgo(90));
    expect(calls.coachingSession[0].where.start_at.gte).toEqual(daysAgo(120));
  });
});

describe('R11-P3b-1 playbook sources: digest and no egress', () => {
  it('digest is sha256 of the sorted ledger, independent of read order', async () => {
    const out = await collector(tables()).svc.collect(H, NOW);
    const sorted = out.ledger
      .map((r) => [r.source_kind, r.source_id, r.client_id ?? ''])
      .sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')));
    expect(out.digest).toBe(createHash('sha256').update(JSON.stringify(sorted)).digest('hex'));
    expect(playbookLedgerDigest([...out.ledger].reverse())).toBe(out.digest);
    expect(playbookLedgerDigest(out.ledger.slice(1))).not.toBe(out.digest);
  });

  it('makes no model call and no writes', () => {
    const src = readFileSync(join(__dirname, '../../src/roman/playbook/playbook-sources.ts'), 'utf8');
    expect(src).not.toMatch(/anthropic|ROMAN_ANTHROPIC_CLIENT|fetch\(|prisma\.\w+\.(?:create|update|upsert|delete)|\$transaction/i);
  });
});
