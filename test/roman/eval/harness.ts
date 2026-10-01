// test/roman/eval/harness.ts
//
// Runs one golden turn through the REAL Roman stack (R1 model config, R3
// context builder, R4 router + post-check) against the in-memory persona DB
// and the stub model. No network, no real DB.

import 'reflect-metadata';
import { RomanService } from '../../../src/roman/roman.service';
import { RomanClientContextService } from '../../../src/roman/context/roman-client-context.service';
import type { AuditService } from '../../../src/audit/audit.service';
import { FEATURE_ROMAN_CHAT_ENABLED_ENV } from '../../../src/roman/roman.feature';
import {
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
import { makeStubModel, type StubModel } from './stub-model';
import type { GoldenItem, GoldenPersona } from './golden-set';

export const PERSONA_ID: Record<GoldenPersona, string> = { P1, P2, P3, P4 };

export interface HarnessWorld {
  db: PersonaDb;
  ctx: RomanClientContextService;
  intake: FakeSafetyIntakeSource;
  model: StubModel;
  roman: RomanService;
  audit: { write: jest.Mock };
}

export function makeWorld(defaultReply?: string): HarnessWorld {
  const db = makePersonaDb();
  const intake = new FakeSafetyIntakeSource();
  const ctx = new RomanClientContextService(db.prisma, intake);
  const model = makeStubModel(defaultReply);
  const roman = new RomanService(db.prisma, model.client);
  roman.setClientContext(ctx);
  const audit = { write: jest.fn(async (_input: Record<string, unknown>) => undefined) };
  // @ts-expect-error partial structural mock of AuditService — only write() is stubbed.
  const auditDouble: AuditService = audit;
  roman.setAudit(auditDouble);
  return { db, ctx, intake, model, roman, audit };
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
}

/** Run one turn for `item.persona` (or an explicit user id) with an optional canned model reply. */
export async function runTurn(
  world: HarnessWorld,
  item: Pick<GoldenItem, 'persona' | 'question'>,
  opts: { reply?: string | string[]; userId?: string; exclamation_used?: boolean } = {},
): Promise<TurnResult> {
  const userId = opts.userId ?? PERSONA_ID[item.persona];
  if (opts.reply !== undefined) world.model.enqueue(opts.reply);
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
