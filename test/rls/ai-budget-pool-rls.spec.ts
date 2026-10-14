/**
 * AIBUDGET: AI usage is charged only to the right coach's pool.
 * AiGatewayService.resolveBudgetCoachId read the subject's coach_id before the
 * subject's role, so a coach whose coach_id names another coach (an old
 * guest-checkout stamp, legacy data, a removed sub-coach) charged that other
 * coach's monthly AI pool. Now a client draws on their coach's pool and a
 * coach on their own (the head coach's while seated on a team), and no other
 * pool moves. Real AiGatewayService and CoachAIBudgetService on the replayed
 * migration chain; only the model provider and the consent reader are fakes.
 * The last case reads the pool rows as the API role `authenticated`.
 * B1 (Sol, fix round 1): the coach a retained coach_id points at (b for a,
 * h for the removed x) cannot name that coach-role user through
 * POST /ai/gateway/invoke or the gateway: refused before their private
 * context reaches the provider, with no provider call, draft or debit.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma.service';
import { AiGatewayRequest, AiGatewayService } from '../../src/ai/gateway/ai-gateway.service';
import { AiGatewayConfig } from '../../src/ai/gateway/ai-gateway.config';
import { AiRedactionService } from '../../src/ai/gateway/ai-redaction.service';
import { AiProviderRegistry } from '../../src/ai/gateway/providers/provider-registry';
import { StubProviderAdapter } from '../../src/ai/gateway/providers/stub-provider.adapter';
import type { AiProviderAdapter } from '../../src/ai/gateway/providers/ai-provider.types';
import type { AnthropicProviderAdapter } from '../../src/ai/gateway/providers/anthropic-provider.adapter';
import { CoachAIBudgetService } from '../../src/ai-credits/coach-ai-budget.service';
import { AiGatewayController } from '../../src/ai/gateway/ai-gateway.controller';
import type { AiApprovalService } from '../../src/ai/gateway/ai-approval.service';
import { PrivateContextService } from '../../src/ai/gateway/private-context.service';
import type { AuthedRequest } from '../../src/auth/auth-request';
import { fakeOf, grantAllEgress } from '../ai-egress/ai-egress.fakes';
import { liveTestDatabaseUrl } from '../utils/live-test-db';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('ai-budget-pool-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

// A metered capability whose route runs any signed-in person as a client
// (GET /wearables/insights/client; a coach passes the student role check).
const CAPABILITY = 'wearable_insight.client';
// A metered coach draft that needs approval (writes an AiActionDraft).
const DRAFT = 'draft.coach_message';
const GATEWAY_ENV = {
  AI_GATEWAY_ENABLED: 'true',
  AI_GATEWAY_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'live-test',
  AI_GATEWAY_CAPABILITIES: `${CAPABILITY},${DRAFT}`,
};

(DB_URL ? describe : describe.skip)('AIBUDGET: AI usage is charged only to the right coach pool', () => {
  const prisma = new PrismaService({ datasources: { db: { url: DB_URL } } });
  const budget = new CoachAIBudgetService(prisma);
  const sent: string[] = []; // the system prompt of every provider call
  const model: AiProviderAdapter = {
    name: 'anthropic',
    complete: async (r) => {
      sent.push(r.systemPrompt);
      return { provider: 'anthropic', model: 'live-test', text: 'ok', enabled: true, promptTokenEstimate: 1000, responseTokenEstimate: 200 };
    },
  };
  const gateway = new AiGatewayService(
    prisma, new AiGatewayConfig(), new AiRedactionService(),
    new AiProviderRegistry(new StubProviderAdapter(), fakeOf<AnthropicProviderAdapter>(model)),
    grantAllEgress(), budget,
  );
  const route = new AiGatewayController(gateway, fakeOf<AiApprovalService>({}), new PrivateContextService(prisma));
  /** POST /ai/gateway/invoke as `who`; naming a subject drafts a message to them. */
  const viaRoute = (who: string, role: 'coach' | 'student', subject?: string) =>
    route.invoke(fakeOf<AuthedRequest>({ user: { id: who, role, coach_id: null }, headers: {} }), {
      capability: subject ? DRAFT : CAPABILITY,
      message: 'Draft a check-in.',
      subject_user_id: subject,
      proposed_action: subject ? { clientId: subject, body: 'Checking in.' } : undefined,
    });
  const drafts = (subject: string) => prisma.aiActionDraft.count({ where: { subject_user_id: subject } });
  /** Private context only that person's own profile holds. */
  const secret = (id: string) => `private-${id}`;
  // Fictional people, fresh ids per run. Coaches: h (head coach), b (another
  // coach), a (coach_id = b, the old guest-checkout stamp; no seat), x (removed
  // from h's team: seat archived, coach_id = h kept), s (seated under h).
  // Clients: ch (coach h), cx (stayed with x). o: the owner.
  const [h, b, a, x, s, ch, cx, o] = Array.from({ length: 8 }, () => randomUUID());
  const pools = [h, b, a, x, s, o];
  const savedEnv = { ...process.env };

  /** Each pool's exact usage this period (a missing row is 0). */
  const usage = async (): Promise<Record<string, number>> => {
    const rows = await prisma.coachAIBudget.findMany({ where: { coach_user_id: { in: pools } } });
    const used = Object.fromEntries(pools.map((id) => [id, 0]));
    for (const r of rows) used[r.coach_user_id] = Number(r.actual_used_micro_cents);
    return used;
  };
  type Call = Pick<AiGatewayRequest, 'requester' | 'subjectUserId' | 'tenantCoachId'>;
  const invoke = (call: Call) =>
    gateway.invoke({ capability: CAPABILITY, userMessage: 'How did I sleep?', systemPrompt: 'live test', ...call });
  /** The pools one call moved. */
  const charged = async (call: Call): Promise<string[]> => {
    const before = await usage();
    await invoke(call);
    const after = await usage();
    return pools.filter((id) => after[id] !== before[id]);
  };

  beforeAll(async () => {
    Object.assign(process.env, GATEWAY_ENV);
    const people: Array<[string, 'coach' | 'student' | 'owner', string | null]> = [
      [h, 'coach', null], [b, 'coach', null], [a, 'coach', b], [x, 'coach', h], [s, 'coach', h],
      [ch, 'student', h], [cx, 'student', x], [o, 'owner', null],
    ];
    for (const [id, role, coach_id] of people) {
      await prisma.user.create({ data: { id, supabase_id: id, email: `${id}@example.test`, name: 'Pool person', role, coach_id } });
      await prisma.userProfile.create({
        data: { user_id: id, equipment_access: [secret(id)], preferred_snacks: [], dietary_restrictions: [] },
      });
    }
    await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: h, sub_coach_id: x, archived_at: new Date('2027-04-01') } });
    await prisma.teamSubCoachAssignment.create({ data: { head_coach_id: h, sub_coach_id: s } });
  });
  afterAll(async () => {
    process.env = savedEnv;
    await prisma.$disconnect();
  });

  it('a coach whose coach_id names another coach uses their own pool, never that coach', async () => {
    expect(await charged({ requester: { id: a, role: 'student' }, subjectUserId: a })).toEqual([a]);
    expect(await charged({ requester: { id: a, role: 'coach' }, tenantCoachId: a })).toEqual([a]);
  });

  it('a removed sub-coach uses their own pool, not their old head coach', async () => {
    expect(await charged({ requester: { id: x, role: 'student' }, subjectUserId: x })).toEqual([x]);
  });

  it('the owner asking about a coach charges that coach, not whoever their coach_id names', async () => {
    expect(await charged({ requester: { id: o, role: 'owner' }, subjectUserId: a })).toEqual([a]);
  });

  it('clients draw on their coach: a seated sub-coach and the head coach share the head pool', async () => {
    expect(await charged({ requester: { id: ch, role: 'student' }, subjectUserId: ch })).toEqual([h]);
    expect(await charged({ requester: { id: cx, role: 'student' }, subjectUserId: cx })).toEqual([x]);
    expect(await charged({ requester: { id: s, role: 'student' }, subjectUserId: s })).toEqual([h]);
  });

  it('a coach cannot spend AI on another coach client: 404 and no pool moves', async () => {
    const before = await usage();
    await expect(invoke({ requester: { id: a, role: 'coach' }, subjectUserId: ch, tenantCoachId: a }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(await usage()).toEqual(before);
  });

  it.each([
    ['b names a, whose old coach_id is b', b, a],
    ['h names x, the removed sub-coach whose coach_id is still h', h, x],
  ])('B1: %s: refused before private context reaches the provider; no call, draft or debit', async (_t, linked, subject) => {
    const before = await usage();
    const calls = sent.length;
    // The route: PrivateContextService refuses before the gateway runs.
    await expect(viaRoute(linked, 'coach', subject)).rejects.toBeInstanceOf(ForbiddenException);
    // The gateway on its own (any caller handing it a subject): the roster 404.
    await expect(gateway.invoke({
      capability: DRAFT, userMessage: 'Draft a check-in.', systemPrompt: secret(subject),
      requester: { id: linked, role: 'coach' }, subjectUserId: subject, tenantCoachId: linked,
      proposedActionPayload: { clientId: subject, body: 'Checking in.' },
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(sent.length).toBe(calls);
    expect(await drafts(subject)).toBe(0);
    expect(await usage()).toEqual(before);
  });

  it('B1: through the route, self-use and a real client still reach the provider with their own context', async () => {
    const calls = sent.length;
    const draftsBefore = await drafts(ch);
    const before = await usage();
    await viaRoute(a, 'coach');
    await viaRoute(ch, 'student');
    await viaRoute(h, 'coach', ch);
    const after = await usage();
    expect(pools.filter((id) => after[id] !== before[id])).toEqual([h, a]);
    expect(sent.slice(calls).map((p) => [a, ch].find((id) => p.includes(secret(id))))).toEqual([a, ch, ch]);
    expect(await drafts(ch)).toBe(draftsBefore + 1);
  });

  it('as the API role, a coach reads only their own pool row and a client reads none', async () => {
    const readable = (who: string, role: string) =>
      prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role);
        await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, JSON.stringify({ sub: who, role: 'authenticated' }));
        const rows = await tx.$queryRawUnsafe<{ coach_user_id: string }[]>(
          `SELECT "coach_user_id" FROM public."CoachAIBudget" WHERE "coach_user_id" IN (${pools.map((_, i) => `$${i + 1}`).join(', ')})`,
          ...pools);
        return rows.map((r) => r.coach_user_id);
      });
    for (const id of [a, h]) await budget.getOrCreateCurrentPeriod(id);
    expect(await readable(a, 'coach')).toEqual([a]);
    expect(await readable(h, 'coach')).toEqual([h]);
    expect(await readable(ch, 'student')).toEqual([]);
  });
});
