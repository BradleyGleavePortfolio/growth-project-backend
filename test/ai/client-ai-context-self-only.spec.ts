/**
 * R2b fix round (A-626-2) — the client's own AI chat sends ONLY that client's
 * own data.
 *
 * End to end through the real code: AiService.chat -> real
 * ClientAIContextService -> real AnthropicAdapter -> real AiEgressService ->
 * the provider client (an in-memory fake that records the exact request).
 * The in-memory database holds a consenting caller, a roster peer with NO
 * grant, and the coach's private session note. Before the fix the request
 * carried the coach-only note and the peer's community win while the ledger
 * was asked only about the caller. Now neither reaches the provider, and
 * every context read is scoped to the caller.
 */
// The provider SDK is replaced by an in-memory recorder, so the test drives the
// production client construction path (no injected client) and sees the
// exact request body.
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
}));

import { AiService } from '../../src/ai/ai.service';
import { AnthropicAdapter } from '../../src/ai/adapters/anthropic.adapter';
import { AIGuardrailsService } from '../../src/ai/ai-guardrails.service';
import { ClientAIContextService } from '../../src/ai/client-ai-context.service';
import type { CoachAIStateService } from '../../src/ai/coach/coach-ai-state.service';
import type { AnalyticsService } from '../../src/analytics/analytics.service';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../src/prisma.service';
import { egressWithGrants, fakeOf } from '../ai-egress/ai-egress.fakes';

const CALLER = 'client-a';
const PEER = 'client-b';
const COACH = 'coach-1';
const PRIVATE_NOTE = 'PRIVATE_COACH_ONLY_NOTES_ABOUT_CLIENT_A';
const PEER_WIN = 'OTHER_CLIENT_WITH_NO_GRANT_HEALTH_WIN';
const OWN_WIN = 'OWN_WIN_FIRST_5K';

type Row = Record<string, unknown>;
type Args = { where?: Record<string, unknown>; select?: Record<string, boolean>; take?: number };

/** Equality on scalar where-keys; operator objects (gte, not, ...) are ignored. */
function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) =>
    v !== null && typeof v === 'object' && !(v instanceof Date) ? true : row[k] === v,
  );
}

function project(row: Row, select: Record<string, boolean> | undefined): Row {
  if (!select) return row;
  return Object.fromEntries(
    Object.keys(select)
      .filter((k) => select[k])
      .map((k) => [k, row[k]]),
  );
}

/** In-memory tables with a recording findMany / findFirst / findUnique per model. */
function fakeDb(tables: Record<string, Row[]>) {
  const reads: Array<{ model: string; where: Record<string, unknown> | undefined }> = [];
  const model = (name: string) => ({
    findMany: jest.fn(async (args: Args = {}) => {
      reads.push({ model: name, where: args.where });
      const rows = (tables[name] ?? []).filter((r) => matches(r, args.where));
      return rows.slice(0, args.take ?? rows.length).map((r) => project(r, args.select));
    }),
    findFirst: jest.fn(async (args: Args = {}) => {
      reads.push({ model: name, where: args.where });
      const row = (tables[name] ?? []).find((r) => matches(r, args.where));
      return row ? project(row, args.select) : null;
    }),
    findUnique: jest.fn(async (args: Args = {}) => {
      reads.push({ model: name, where: args.where });
      const row = (tables[name] ?? []).find((r) => matches(r, args.where));
      return row ? project(row, args.select) : null;
    }),
  });
  const prisma = {
    user: model('user'),
    loggedFoodEntry: model('loggedFoodEntry'),
    workoutSession: model('workoutSession'),
    weightLog: model('weightLog'),
    habit: model('habit'),
    checkIn: model('checkIn'),
    coachMessage: model('coachMessage'),
    coachGuideline: model('coachGuideline'),
    mealPlan: model('mealPlan'),
    fastingWindow: model('fastingWindow'),
    coachingSession: model('coachingSession'),
    communityWin: model('communityWin'),
    // AiService daily quota + audit (not under test here).
    userAIQuota: {
      upsert: jest.fn(async () => ({ tokens_used: 0, request_count: 0 })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    aiRequestAudit: { create: jest.fn(async () => ({})) },
    aICallLog: { create: jest.fn(async () => ({})) },
  };
  return { prisma, reads };
}

function seed() {
  const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const now = new Date();
  return fakeDb({
    user: [
      {
        id: CALLER,
        name: 'Alex Client',
        coach_id: COACH,
        profile: null,
        show_on_leaderboard: false,
      },
      { id: PEER, name: 'Blair Peer', coach_id: COACH, profile: null, show_on_leaderboard: true },
      { id: COACH, name: 'Sam Coach', coach_id: null, profile: null },
    ],
    coachingSession: [
      {
        client_id: CALLER,
        coach_id: COACH,
        start_at: soon,
        title: 'Tuesday check-in',
        coach_notes_md: PRIVATE_NOTE,
        client_recap_md: null,
      },
    ],
    communityWin: [
      { user_id: PEER, coach_id: COACH, title: PEER_WIN, created_at: now },
      { user_id: CALLER, coach_id: COACH, title: OWN_WIN, created_at: now },
    ],
  });
}

function buildChat(prisma: ReturnType<typeof seed>['prisma'], granted: string[]) {
  const { egress, reader } = egressWithGrants(granted);
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: 'Keep going with your training plan.' }],
    usage: { input_tokens: 10, output_tokens: 5 },
    model: 'claude-test',
  });
  const create = mockCreate;
  const adapter = new AnthropicAdapter(
    fakeOf<ConfigService>({ get: () => 'test-key' }),
    fakeOf<PrismaService>(prisma),
    egress,
  );
  const svc = new AiService(
    fakeOf<PrismaService>(prisma),
    new ClientAIContextService(fakeOf<PrismaService>(prisma)),
    new AIGuardrailsService(),
    fakeOf<AnalyticsService>({ capture: jest.fn(), identify: jest.fn() }),
    egress,
    adapter,
    fakeOf<CoachAIStateService>({ isReady: () => true }),
  );
  return { svc, create, reader };
}

describe('A-626-2 — /ai/chat context is own-data only', () => {
  it("the provider request carries neither the private coach note nor a peer's win", async () => {
    const { prisma } = seed();
    const { svc, create, reader } = buildChat(prisma, [CALLER]);
    const result = await svc.chat(CALLER, 'how am I doing this week', []);
    expect(result.model_used).toBe('anthropic');
    expect(create).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(create.mock.calls[0]);
    expect(sent).not.toContain(PRIVATE_NOTE);
    expect(sent).not.toContain(PEER_WIN);
    expect(sent).not.toContain(PEER);
    // The caller's own data still flows (proves the context was rendered).
    expect(sent).toContain(OWN_WIN);
    expect(sent).toContain('Tuesday check-in');
    // Only the caller's grant was asked for, and only the caller's data was sent.
    expect(reader.calls.flat().every((id) => id === CALLER)).toBe(true);
  });

  it("every context read is scoped to the caller (or is the caller's coach record)", async () => {
    const { prisma, reads } = seed();
    await new ClientAIContextService(fakeOf<PrismaService>(prisma)).buildFresh(CALLER);
    const unscoped = reads.filter(({ model, where }) => {
      const w = where ?? {};
      if (model === 'user') return !(w.id === CALLER || w.id === COACH);
      if (model === 'coachGuideline') return false; // compound key (coach_id, client_id) checked below
      return !(w.user_id === CALLER || w.client_id === CALLER);
    });
    expect(unscoped).toEqual([]);
    const wins = reads.find((r) => r.model === 'communityWin');
    expect(wins?.where).toMatchObject({ user_id: CALLER });
    const session = prisma.coachingSession.findFirst.mock.calls[0][0] as Args;
    expect(session.select).toEqual({ start_at: true, title: true });
  });

  it("the rendered context has no coach-note field and labels wins as the client's own", async () => {
    const { prisma } = seed();
    const ctxSvc = new ClientAIContextService(fakeOf<PrismaService>(prisma));
    const ctx = await ctxSvc.buildFresh(CALLER);
    expect(ctx.next_session).toEqual({ date: expect.any(String), title: 'Tuesday check-in' });
    expect(ctx.recent_wins.map((w) => w.title)).toEqual([OWN_WIN]);
    const text = ctxSvc.renderForPrompt(ctx);
    expect(text).toContain(`my_recent_wins: "${OWN_WIN}"`);
    expect(text).not.toContain('roster_wins');
    expect(text).not.toContain('note:');
  });
});
