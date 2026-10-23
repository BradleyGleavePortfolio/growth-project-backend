import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma.service';
import { AiEgressService } from '../ai-egress/ai-egress.service';
import { ConsentScope, ConsentService } from '../consent/consent.service';
import type { RomanClientContext } from '../roman/context/roman-client-context.types';
import { coachLabel, localClock, localDateOf } from '../roman/context/roman-client-context.service';
import { CLIENT_PATH_CHANGE, MOVE_WINDOW, PATH_CHANGE_PENDING_MS, parsePathChange, type PathChange } from '../ai/gateway/materialisers/client-path-change.materialiser';
import { coachSetTarget, suggestionView, type CopilotSuggestionView } from './copilot.service';

/**
 * COPILOT-BE2: a Path Copilot turn is an ordinary Roman turn (coach, consent, caps, pool, safety router and post-check all
 * unchanged) that the app opts into with this header, '1', while FEATURE_CLIENT_PATH_COPILOT is on. Roman then answers from
 * numbered facts the server wrote, cites them as [n], and may end with one suggested plan change, which is stored as the
 * client's own unsent row. Without the header a turn, its done frame and its message views are exactly today's.
 */
export const ROMAN_COPILOT_HEADER = 'x-roman-copilot';

/** One numbered fact (CP-A-17). The server writes `label` and `detail`; the model only cites `n`. */
const sourceSchema = z.object({
  n: z.int(), kind: z.enum(['plan', 'check_in', 'food_log', 'workout_log']), id: z.string().nullable(), date: z.string(), label: z.string(), detail: z.string().nullable(),
});
export type CopilotSource = z.infer<typeof sourceSchema>;
export type CopilotSourceKind = CopilotSource['kind'];
export interface CopilotFacts {
  sources: CopilotSource[];
  /** Open sessions inside the move window, referred to as S1, S2 ... */
  sessions: Array<{ assignment_id: string; workout: string; at: Date }>;
  target: { id: string; kcal: number } | null;
  floor: number;
  tz: string;
}
/** `copilot` on the done frame and on a message view: the facts the reply cites and its suggestion, if any. */
export interface CopilotReply { sources: CopilotSource[]; suggestion: CopilotSuggestionView | null }
/** What the reply row stores (RomanMessage.copilot), read back through the same shape (anything else reads as no facts). */
const storedSchema = z.object({ question_id: z.string().nullable(), sources: z.array(sourceSchema), suggestion_id: z.string().nullable() });
export type StoredCopilot = z.infer<typeof storedSchema>;
export const storedCopilotOf = (v: Prisma.JsonValue | null | undefined): StoredCopilot | null => storedSchema.safeParse(v).data ?? null;
/** A Copilot reply's text without its [n] markers: what an app without ROMAN_COPILOT_HEADER and Roman's own history read. */
export const withoutCites = (text: string) => text.replace(/ ?\[\d+\]/g, '');

/** The coach-sharing scope of each kind (#SHARE-SIMPLE): a kind the client's coach may not read is never a fact. */
const SHARED = { check_in: ConsentScope.FITNESS_BODY_METRICS, food_log: ConsentScope.FITNESS_FOOD_MACROS, workout_log: ConsentScope.FITNESS_WORKOUTS } as const;
const KIND: Record<CopilotSourceKind, string> = { plan: 'Plan', check_in: 'Check-in', food_log: 'Food log', workout_log: 'Workout log' };
const LB_PER_KG = 2.20462;
const num = (n: number) => Math.round(n).toLocaleString('en-US');
/** "Mon 19 Oct": an instant in the client's zone; a YYYY-MM-DD as that calendar day. */
const dayLabel = (d: Date | string, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: typeof d === 'string' ? 'UTC' : tz }).format(
    typeof d === 'string' ? new Date(`${d}T00:00:00Z`) : d,
  );

/** The Copilot section of Roman's system prompt (a client-surface augment block). */
export function copilotSection(f: CopilotFacts): string {
  const day = localDateOf(f.tz);
  const list = (rows: string[]) => (rows.length ? rows.join('\n') : '(none)');
  return [
    '# PATH COPILOT',
    'The client is asking from Path Copilot: why their plan is what it is, and what to do next.',
    'Start with one short sentence that answers the question, on its own line. Use only these facts and client_data.',
    'After each sentence that uses a fact, put its number in square brackets, like [1]. Cite only numbers listed here.',
    `Facts:\n${list(f.sources.map((s) => `[${s.n}] ${KIND[s.kind]}: ${s.label}`))}`,
    `Sessions that can move:\n${list(f.sessions.map((s, i) => `S${i + 1}: ${s.workout}, ${dayLabel(s.at, f.tz)} (${day(s.at)})`))}`,
    'You never change the plan. When the honest answer is a change (one session above to another day, or a new daily calorie',
    'target), say the coach decides plan changes and end the reply with exactly one line, either',
    '<suggestion>{"kind":"move_session","session":"S1","to":"YYYY-MM-DD","reason":"...","sources":[1]}</suggestion>',
    'or <suggestion>{"kind":"set_calorie_target","to_kcal":2000,"reason":"...","sources":[1]}</suggestion>.',
    'The reason is one or two plain sentences for the coach, who sees the change, the reason and the cited facts, never this',
    'conversation. Never write the new calorie number in the reply itself. No suggestion when nothing needs to change.',
  ].join('\n');
}

const TAG = /<suggestion>([\s\S]*?)<\/suggestion>/gi;
const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

/** Takes Roman's suggestion line out of the reply (also an unclosed one) and drops citations of facts that do not exist. */
export function splitCopilotReply(raw: string, f: CopilotFacts): { text: string; asked: unknown } {
  let asked: unknown = null;
  const text = raw
    .replace(TAG, (_m, body: string) => {
      if (asked === null) asked = parseJson(body); // not JSON: undefined, no suggestion
      return '';
    })
    .replace(/<suggestion>[\s\S]*$/i, '')
    .replace(/<\/suggestion>/gi, '')
    .replace(/\[(\d+)\]/g, (m, d: string) => (f.sources.some((s) => s.n === Number(d)) ? m : ''))
    .trim();
  return { text, asked };
}

/** The change Roman asked for, filled from the server's own facts (the model never supplies an id or a time), or null. */
export function copilotChange(asked: unknown, f: CopilotFacts, now = new Date()): { change: PathChange; reason: string } | null {
  if (!asked || typeof asked !== 'object') return null;
  const a = asked as Record<string, unknown>;
  const reason = typeof a.reason === 'string' ? a.reason.trim() : '';
  if (!reason || reason.length > 300) return null;
  const sources = (Array.isArray(a.sources) ? [...new Set(a.sources)] : [])
    .map((n) => f.sources.find((s) => s.n === n))
    .filter((s): s is CopilotSource => !!s)
    .slice(0, 6)
    .map(({ kind, id, date, label }) => ({ kind, id, date, label }));
  let change: unknown = null;
  if (a.kind === 'move_session' && typeof a.session === 'string' && typeof a.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.to)) {
    const s = f.sessions[Number(a.session.replace(/^S/i, '')) - 1];
    const shift = s ? Date.parse(`${a.to}T00:00:00Z`) - Date.parse(`${localDateOf(f.tz)(s.at)}T00:00:00Z`) : 0;
    if (s && shift) {
      change = { kind: 'move_session', assignment_id: s.assignment_id, workout: s.workout, from_at: s.at.toISOString(), to_at: new Date(s.at.getTime() + shift).toISOString(), sources };
    }
  } else if (a.kind === 'set_calorie_target' && f.target && Number.isInteger(a.to_kcal)) {
    const to = a.to_kcal as number;
    // Never below the floor Roman's own words are held to (post-check), and never the target the client already has.
    if (to >= f.floor && to !== f.target.kcal) {
      change = { kind: 'set_calorie_target', target_id: f.target.id, from_kcal: f.target.kcal, to_kcal: to, sources };
    }
  }
  if (!change) return null;
  try {
    return { change: parsePathChange(change, now.getTime()), reason };
  } catch {
    return null;
  }
}

@Injectable()
export class CopilotTurnService {
  private readonly logger = new Logger(CopilotTurnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
    private readonly egress: AiEgressService,
  ) {}

  /** The numbered facts of one Copilot turn, from the same context the prompt and the post-check read. */
  async facts(clientId: string, ctx: RomanClientContext, now = new Date()): Promise<CopilotFacts> {
    const tz = localClock(now, ctx.identity.timezone).timezone;
    const user = await this.prisma.user.findUnique({ where: { id: clientId }, select: { coach_id: true, profile: { select: { weight_unit: true } } } });
    const granted = user?.coach_id
      ? (await this.consent.grantedScopesByClient(user.coach_id, [clientId], Object.values(SHARED))).get(clientId)
      : undefined;
    const shares = (k: keyof typeof SHARED) => granted?.has(SHARED[k]) === true;
    const [targets, moves] = await Promise.all([
      // The same row MacrosService.getCurrentForClient reads (the approval checks it is still current), and the one before it.
      this.prisma.macroTarget.findMany({
        where: { client_id: clientId, archived_at: null, effective_from: { lte: now } },
        orderBy: { effective_from: 'desc' },
        take: 2,
        select: { id: true, coach_id: true, calories_kcal: true, effective_from: true },
      }),
      shares('workout_log')
        ? this.prisma.clientWorkoutAssignment.findMany({
            where: { client_id: clientId, completed_at: null, skipped_at: null, scheduled_for: { gte: new Date(now.getTime() - MOVE_WINDOW.backMs), lte: new Date(now.getTime() + MOVE_WINDOW.aheadMs) } },
            orderBy: { scheduled_for: 'asc' },
            take: 8,
            select: { id: true, scheduled_for: true, assigned_by_coach_id: true, snapshot: { select: { plan_name: true } }, workout_plan: { select: { name: true } } },
          })
        : [],
    ]);
    // CAC-NAME: a plan title is its assigner's (a former coach's too), generic until that coach allows AI; read now, fail closed.
    const allowed = await this.egress.consentedCoaches(moves.map((m) => m.assigned_by_coach_id).filter((id) => id !== clientId));
    const titleOf = (m: (typeof moves)[number]) =>
      coachLabel(m.assigned_by_coach_id === clientId || allowed.has(m.assigned_by_coach_id), m.snapshot?.plan_name ?? m.workout_plan.name, 80, 'Workout');
    const rows: Array<Omit<CopilotSource, 'n'>> = [];
    const [current, previous] = targets;
    if (current) {
      // CAC-NAME: the coach is named only where the context names them (that coach allows AI).
      const by = coachSetTarget(current, user?.coach_id) && ctx.coach.coach_first_name ? `, set by ${ctx.coach.coach_first_name}` : '';
      const label = `Target ${num(current.calories_kcal)} kcal from ${dayLabel(current.effective_from, tz)}${by}`;
      rows.push({ kind: 'plan', id: current.id, date: localDateOf(tz)(current.effective_from), label, detail: previous ? `Was ${num(previous.calories_kcal)} kcal` : null });
    }
    const points = [...ctx.weight_trend.points].sort((x, y) => y.date.localeCompare(x.date));
    const kg = user?.profile?.weight_unit === 'kg';
    const weight = (p: { date: string; weight_lbs: number }) =>
      `${(kg ? p.weight_lbs / LB_PER_KG : p.weight_lbs).toFixed(1)} ${kg ? 'kg' : 'lbs'} on ${dayLabel(p.date, tz)}`;
    if (shares('check_in') && points[0]) {
      rows.push({ kind: 'check_in', id: null, date: points[0].date, label: weight(points[0]), detail: points[1] ? weight(points[1]) : null });
    }
    const food = ctx.last_7_days;
    if (shares('food_log') && food.days_logged > 0 && food.avg_kcal_on_logged_days !== null) {
      const label = `${num(food.avg_kcal_on_logged_days)} kcal a day over the last 7 days`;
      rows.push({ kind: 'food_log', id: null, date: ctx.identity.local_date, label, detail: `${food.days_logged} of 7 days logged` });
    }
    const done = ctx.plan?.adherence_14d;
    if (shares('workout_log') && done && done.scheduled > 0) {
      rows.push({ kind: 'workout_log', id: null, date: ctx.identity.local_date, label: `${done.completed} of ${done.scheduled} sessions done`, detail: 'Last 14 days' });
    }
    return {
      sources: rows.map((r, i) => ({ n: i + 1, ...r })),
      sessions: moves.map((m) => ({ assignment_id: m.id, workout: titleOf(m), at: m.scheduled_for })),
      target: current ? { id: current.id, kcal: current.calories_kcal } : null,
      floor: ctx.macro_method.floor_kcal ?? 1500,
      tz,
    };
  }

  /** Roman's suggestion as the client's own unsent row: no tenant coach, so no coach can read it until the client taps Send. */
  async saveSuggestion(id: string, clientId: string, sessionId: string, s: { change: PathChange; reason: string }, now = new Date()): Promise<CopilotSuggestionView | null> {
    try {
      const row = await this.prisma.aiActionDraft.create({
        data: {
          id, capability: CLIENT_PATH_CHANGE, status: 'suggested', requester_id: clientId, subject_user_id: clientId, tenant_coach_id: null,
          payload: s.change, rationale: s.reason, provenance: { roman_session_id: sessionId },
          expires_at: new Date(now.getTime() + PATH_CHANGE_PENDING_MS),
        },
      });
      return suggestionView(row);
    } catch (err) {
      this.logger.warn(`copilot.suggestion_not_saved code=${(err as { code?: string }).code ?? 'unknown'}`);
      return null;
    }
  }

  /** Deleting a Roman chat also deletes the suggestions from it that were never sent (inside the erase transaction). */
  forgetUnsent(tx: Prisma.TransactionClient, userId: string, sessionId: string) {
    return tx.aiActionDraft.deleteMany({
      where: { capability: CLIENT_PATH_CHANGE, status: 'suggested', requester_id: userId, provenance: { path: ['roman_session_id'], equals: sessionId } },
    });
  }

  /** `copilot` for each Copilot reply on a message page, with its suggestion's status now. */
  async views(clientId: string, messages: Array<{ id: string; copilot?: Prisma.JsonValue | null }>): Promise<Map<string, CopilotReply>> {
    const stored = messages.flatMap((m) => {
      const c = storedCopilotOf(m.copilot);
      return c ? [[m.id, c] as const] : [];
    });
    const ids = stored.map(([, c]) => c.suggestion_id).filter((x): x is string => !!x);
    const drafts = ids.length
      ? await this.prisma.aiActionDraft.findMany({ where: { id: { in: ids }, capability: CLIENT_PATH_CHANGE, requester_id: clientId, subject_user_id: clientId } })
      : [];
    return new Map(
      stored.map(([id, c]): [string, CopilotReply] => {
        const d = drafts.find((x) => x.id === c.suggestion_id);
        return [id, { sources: c.sources, suggestion: d ? suggestionView(d) : null }];
      }),
    );
  }
}
