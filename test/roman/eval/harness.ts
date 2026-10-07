// test/roman/eval/harness.ts
//
// Runs one golden turn through the REAL Roman stack (R1 model config, R3
// context builder, R4 router + post-check) against the in-memory persona DB
// and the stub model. No network, no real DB.

import 'reflect-metadata';
import { RomanService } from '../../../src/roman/roman.service';
import { RomanClientContextService } from '../../../src/roman/context/roman-client-context.service';
import {
  AiEgressService,
  AnthropicHandle,
  type AnthropicMessagesClient,
} from '../../../src/ai-egress/ai-egress.service';
import { FakeConsentReader, fakeOf } from '../../ai-egress/ai-egress.fakes';
import type { ClientAiConsentScope } from '../../../src/ai-consent/ai-consent.reader';
import type { CoachAIBudgetService } from '../../../src/ai-credits/coach-ai-budget.service';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../../src/roman/roman.feature';
import { RomanReadToolbox } from '../../../src/roman/tools/roman-read-tools';
import type { RomanToolbox } from '../../../src/roman/tools/roman-tool.types';
import { RomanTimelineReader } from '../../../src/roman/memory/roman-timeline.reader';
import { RomanClientMemoryAugmenter } from '../../../src/roman/memory/roman-client-memory.augmenter';
import { RomanCoachMethodAugmenter } from '../../../src/roman/playbook/roman-coach-method.augmenter';
import {
  matches,
  makePersonaDb,
  FakeSafetyIntakeSource,
  P1,
  P2,
  P3,
  P4,
  NOW,
  LOCAL_TODAY_PT,
  type PersonaDb,
} from '../fixtures/roman-personas';
import { makeStubModel, type StubCall, type StubModel, type StubStep } from './stub-model';
import type { GoldenItem, GoldenPersona } from './golden-set';

export const PERSONA_ID: Record<GoldenPersona, string> = { P1, P2, P3, P4 };

export interface HarnessWorld {
  db: PersonaDb;
  ctx: RomanClientContextService;
  intake: FakeSafetyIntakeSource;
  model: StubModel;
  roman: RomanService;
  /** Box-2 consent ledger double behind the REAL AiEgressService (B-R8-1). */
  consent: FakeConsentReader;
}

/** R11-T3: base grant for everyone; the 'memory' scope (client-ai-v5) for all but `v4`. */
class ScopedConsentReader extends FakeConsentReader {
  readonly v4 = new Set<string>();
  async hasClientAiConsent(id: string, scope?: ClientAiConsentScope): Promise<boolean> {
    return (await super.hasClientAiConsent(id)) && !(scope === 'memory' && this.v4.has(id));
  }
  async clientsWithAiConsent(ids: readonly string[], scope?: ClientAiConsentScope) {
    const base = await super.clientsWithAiConsent(ids);
    return new Set([...base].filter((id) => !(scope === 'memory' && this.v4.has(id))));
  }
}

/** R11-T3: rows the v1.1 readers need, kept outside the shared persona fixtures. */
export interface R11Rows {
  exerciseSets: Array<{ exercise_name: string; sets_completed: number; reps_per_set: number[];
    weight_per_set: number[]; rpe: number | null; workout: { user_id: string; date: Date } }>;
  notes: Array<Record<string, unknown>>;
  playbooks: Array<Record<string, unknown>>;
}

export function makeWorld(
  defaultReply?: string,
  r11: { tools?: boolean; augmenters?: boolean; wrapTools?: (t: RomanToolbox) => RomanToolbox } = {},
): HarnessWorld & { r11: R11Rows; consent: ScopedConsentReader } {
  const db = makePersonaDb();
  const intake = new FakeSafetyIntakeSource();
  const ctx = new RomanClientContextService(db.prisma, intake);
  const model = makeStubModel(defaultReply);
  // B-R8-1: the production RomanService over the production egress gate; the
  // only fake is the consent ledger read. Every persona holds a live grant
  // unless a spec revokes it.
  const reader = new ScopedConsentReader([P1, P2, P3, P4]);
  const rows: R11Rows = { exerciseSets: [], notes: [], playbooks: [] };
  const p = fakeOf<Record<string, unknown>>(db.prisma);
  type W = { where?: Record<string, unknown> };
  const where = <R extends object>(xs: R[], w: W['where']) =>
    xs.filter((r) => matches(fakeOf<Record<string, unknown>>(r), w));
  p.exerciseSet = {
    findMany: jest.fn(async (a: { where: { exercise_name: { contains: string }; workout: W['where'] } }) =>
      where(rows.exerciseSets.map((r) => ({ ...r, ...r.workout })), a.where.workout)
        .filter((r) => r.exercise_name.toLowerCase().includes(a.where.exercise_name.contains.toLowerCase()))
        .sort((x, y) => +y.workout.date - +x.workout.date)),
  };
  p.romanClientNote = { findMany: jest.fn(async (a: W) => where(rows.notes, a.where)) };
  p.romanClientSummary = { findMany: jest.fn(async () => []) };
  p.coachPlaybook = { findFirst: jest.fn(async (a: W) => where(rows.playbooks, a.where)[0] ?? null) };
  const budget = fakeOf<CoachAIBudgetService>({ resolveHeadCoachId: async (id: string) => id });
  const roman = new RomanService(
    fakeOf(db.prisma),
    new AiEgressService(reader),
    AnthropicHandle.bind(fakeOf<AnthropicMessagesClient>(model.client)),
    ctx,
    null,
    null,
    r11.augmenters
      ? [new RomanClientMemoryAugmenter(db.prisma), new RomanCoachMethodAugmenter(db.prisma, budget)]
      : null,
    r11.tools ? (r11.wrapTools ?? ((t) => t))(new RomanReadToolbox(db.prisma, new RomanTimelineReader(db.prisma))) : null,
  );
  return { db, ctx, intake, model, roman, consent: reader, r11: rows };
}

export const student = (id: string) => ({ id, role: 'student' });
export const clientSession = (
  user_id: string,
  overrides: Partial<{ exclamation_used: boolean; id: string }> = {},
) => ({
  id: overrides.id ?? `sess_${user_id}`,
  user_id,
  surface: 'client' as const,
  day_key: LOCAL_TODAY_PT,
  message_count: 0,
  started_at: NOW,
  last_activity_at: NOW,
  quips_in_session: 0,
  exclamation_used: overrides.exclamation_used ?? false,
  subject_context_json: null,
  created_at: NOW,
  updated_at: NOW,
  deleted_at: null,
});

export interface TurnResult {
  reply: string;
  chunks: Array<{ type: string; text?: string; messageId?: string }>;
  modelCalls: number;
  /** Static system block of the (single) model call, or null when no call was made. */
  staticSystem: string | null;
  clientData: string | null;
  persisted: Record<string, unknown> | undefined;
  /** R11-T3: every model call of this turn (a tools turn makes several). */
  calls: StubCall[];
}

/** Run one turn for `item.persona` (or an explicit user id) with an optional canned model reply. */
export async function runTurn(
  world: HarnessWorld,
  item: Pick<GoldenItem, 'persona' | 'question'>,
  opts: { reply?: string | string[]; userId?: string; exclamation_used?: boolean; script?: StubStep[] } = {},
): Promise<TurnResult> {
  const userId = opts.userId ?? PERSONA_ID[item.persona];
  if (opts.reply !== undefined) world.model.enqueue(opts.reply);
  if (opts.script) world.model.script(...opts.script);
  const before = world.model.calls.length;
  const chunks: TurnResult['chunks'] = [];
  const session = clientSession(userId, { exclamation_used: opts.exclamation_used });
  for await (const c of world.roman.streamAssistantTurn(student(userId), session, {
    userMessage: item.question,
  })) {
    chunks.push(c as TurnResult['chunks'][number]);
  }
  const done = chunks.find((c) => c.type === 'done');
  const call = world.model.calls[before] ?? null;
  const persisted = world.db.raw.romanMessages.find((m) => m.id === done?.messageId);
  return {
    reply:
      done?.text ??
      chunks
        .filter((c) => c.type === 'delta')
        .map((c) => c.text ?? '')
        .join(''),
    chunks,
    modelCalls: world.model.calls.length - before,
    staticSystem: call?.staticSystem ?? null,
    clientData: call?.clientData ?? null,
    persisted,
    calls: world.model.calls.slice(before),
  };
}

/** Enable the chat flag for a describe block; restores afterwards. */
export function withRomanEnabled(): void {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV];
    process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV] = 'true';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV];
    else process.env[FEATURE_ROMAN_CHAT_ENABLED_ENV] = saved;
  });
}
