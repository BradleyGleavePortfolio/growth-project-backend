/**
 * Owner decision 17, write side, on ONE database connection: the pool the
 * rls-live-tests runner gives every suite (scripts/ci/run-rls-suites.mjs
 * sets connection_limit=1; this suite sets it too). A draft is saved in a
 * transaction that locks the client's row and runs the access check again,
 * so every read of that check must use the transaction's connection. A read
 * through the service's own client waits for a second connection that never
 * comes, and the transaction expires after 5 s ("Transaction already closed").
 * Real AiGatewayService, CoachAIService, WorkoutBuilderService and
 * SubCoachScopeService on the replayed migration chain; only the model
 * providers are fakes. h coaches clients and seats sub-coach s, who holds each
 * client by an open delegation; b is another coach.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../src/prisma.service';
import { AiGatewayService } from '../../src/ai/gateway/ai-gateway.service';
import { AiGatewayConfig } from '../../src/ai/gateway/ai-gateway.config';
import { AiRedactionService } from '../../src/ai/gateway/ai-redaction.service';
import { AiProviderRegistry } from '../../src/ai/gateway/providers/provider-registry';
import { StubProviderAdapter } from '../../src/ai/gateway/providers/stub-provider.adapter';
import type { AnthropicProviderAdapter } from '../../src/ai/gateway/providers/anthropic-provider.adapter';
import { CoachAIService } from '../../src/ai/coach/coach-ai.service';
import type { CoachAIStateService } from '../../src/ai/coach/coach-ai-state.service';
import type { AnthropicAdapter } from '../../src/ai/adapters/anthropic.adapter';
import { ClientContextService } from '../../src/ai/context/client-context.service';
import type { MealPlansService } from '../../src/meal-plans/meal-plans.service';
import { WorkoutBuilderService } from '../../src/workout-builder/workout-builder.service';
import { SubCoachScopeService } from '../../src/sub-coach/sub-coach-scope.service';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('draft-write-recheck-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}
const ONE_CONNECTION = DB_URL ? new URL(DB_URL) : null;
ONE_CONNECTION?.searchParams.set('connection_limit', '1');

const DRAFT = 'draft.coach_message';
const GATEWAY_ENV = {
  AI_GATEWAY_ENABLED: 'true',
  AI_GATEWAY_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'live-test',
  AI_GATEWAY_CAPABILITIES: DRAFT,
  AI_GATEWAY_REQUIRE_APPROVAL: DRAFT,
};
/** Coach `who` asks for an AI draft about client `about`. */
type Ask = (who: string, about: string) => Promise<unknown>;

(DB_URL ? describe : describe.skip)('A draft is re-checked inside its own transaction, on one connection', () => {
  const prisma = new PrismaService({ datasources: { db: { url: ONE_CONNECTION?.toString() ?? '' } } });
  const [h, s, b] = Array.from({ length: 3 }, () => randomUUID());
  const savedEnv = { ...process.env };
  let calls = 0;
  let moving: string | null = null;
  /** The model is answering: count the call, and move `moving` to coach b now if set. */
  const answer = async () => {
    calls += 1;
    if (moving) await prisma.user.update({ where: { id: moving }, data: { coach_id: b } });
    moving = null;
  };
  const gateway = new AiGatewayService(prisma, new AiGatewayConfig(), new AiRedactionService(),
    new AiProviderRegistry(new StubProviderAdapter(), fakeOf<AnthropicProviderAdapter>({
      name: 'anthropic',
      complete: async () => {
        await answer();
        return { provider: 'anthropic', model: 'live-test', text: 'Nice week.', enabled: true, promptTokenEstimate: 1, responseTokenEstimate: 1 };
      },
    })), grantAllEgress());
  const coachAi = new CoachAIService(prisma, fakeOf<CoachAIStateService>({ isReady: () => true }),
    fakeOf<AnthropicAdapter>({
      completeStructured: async () => {
        await answer();
        return { data: { summary: 'Steady week' }, tokensIn: 1, tokensOut: 1, modelUsed: 'live-test', latencyMs: 1 };
      },
    }), new ClientContextService(prisma), fakeOf<MealPlansService>({}),
    new WorkoutBuilderService(prisma, undefined, new SubCoachScopeService(prisma)));

  const person = (id: string, role: 'coach' | 'student', coach_id: string | null) =>
    prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: 'Draft person', role, coach_id } });
  /** A new client of h, delegated to s. */
  const client = async () => {
    const id = randomUUID();
    await person(id, 'student', h);
    await prisma.subCoachAssignment.create({ data: { head_coach_id: h, sub_coach_id: s, client_id: id } });
    return id;
  };
  const viaGateway: Ask = (who, about) => gateway.invoke({
    capability: DRAFT, userMessage: 'Draft a check-in.', systemPrompt: 'live test',
    requester: { id: who, role: 'coach' }, subjectUserId: about, tenantCoachId: who,
  });
  const viaCoachAi: Ask = (who, about) => coachAi.generateClientInsight(who, { clientId: about });
  const saved = async (who: string, about: string) =>
    (await prisma.aiActionDraft.count({ where: { requester_id: who, subject_user_id: about } }))
    + (await prisma.aIDraft.count({ where: { coachId: who, clientId: about } }));

  beforeAll(async () => {
    Object.assign(process.env, GATEWAY_ENV);
    await person(h, 'coach', null);
    await person(s, 'coach', h);
    await person(b, 'coach', null);
    await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: h, sub_coach_id: s } });
  });
  afterAll(async () => {
    process.env = savedEnv;
    await prisma.$disconnect();
  });

  it.each<[string, Ask]>([['the AI gateway', viaGateway], ['Coach AI', viaCoachAi]])(
    '%s saves the draft for the coach and the delegated sub-coach; another coach gets 404 and none',
    async (_path, ask) => {
      const c = await client();
      await ask(h, c);
      await ask(s, c);
      expect([await saved(h, c), await saved(s, c)]).toEqual([1, 1]);
      await expect(ask(b, c)).rejects.toBeInstanceOf(NotFoundException);
      expect(await saved(b, c)).toBe(0);
    },
  );

  it.each<[string, string, Ask, string]>([
    ['the AI gateway', 'the coach', viaGateway, h],
    ['the AI gateway', 'the delegated sub-coach', viaGateway, s],
    ['Coach AI', 'the coach', viaCoachAi, h],
    ['Coach AI', 'the delegated sub-coach', viaCoachAi, s],
  ])('%s saves nothing for %s when the client moves during the model call', async (_path, _label, ask, who) => {
    const c = await client();
    const before = calls;
    moving = c;
    await expect(ask(who, c)).rejects.toBeInstanceOf(NotFoundException);
    expect(calls).toBe(before + 1);
    expect(await saved(who, c)).toBe(0);
  });
});
