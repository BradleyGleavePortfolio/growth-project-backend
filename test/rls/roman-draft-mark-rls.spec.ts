/**
 * ROMANMARK-B1 + ROMANMARK-BE: a coach message carries its draft id
 * (CoachMessage.ai_draft_id, the Roman mark) only when Roman wrote the draft on
 * the server for that coach and client. Consent counts when Roman writes it
 * (#ROMANMARK-CONSENT-MARK op 1): a draft written while the client allowed AI
 * help is sent with its mark after they turn it off, and no draft is written
 * after that. A wearable `approve` sends Roman's stored suggestion, marked,
 * when its body matches it after the app's trim, and is refused (400, nothing
 * sent) otherwise; a sync expires the suggestion and keeps it for that check.
 * PATHS walks every way a coach-thread message is written,
 * through the real controllers, services, gateway, consent ledger and
 * materialisers on the replayed migration chain, and reads each result back
 * at the row layer as role authenticated (no row-security bypass): the
 * thread's coach and client read every row and its draft id, the control for
 * the zeros: another coach and another client read none. Both thread routes
 * return the id.
 *
 * Runs in the rls-live-tests job on a superuser copy of rls_replay.
 * Gate: TEST_DATABASE_URL. No URL -> skip, except under CI=true (hard failure).
 */
import { randomUUID } from 'crypto';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient, WearableMetricBucket, WearableMetricType, WearableProvider } from '@prisma/client';
import { liveTestDatabaseUrl } from '../utils/live-test-db';
import { cast } from '../engagement/_fake-db';
import type { PrismaService } from '../../src/prisma.service';
import type { AuthedRequest } from '../../src/auth/auth-request';
import type { CreateMessageDto } from '../../src/messaging/messaging.dto';
import { MessagingService } from '../../src/messaging/messaging.service';
import { CoachMessagingController } from '../../src/messaging/coach-messaging.controller';
import { ClientMessagingController } from '../../src/messaging/client-messaging.controller';
import { AiApprovalService } from '../../src/ai/gateway/ai-approval.service';
import { AiGatewayController } from '../../src/ai/gateway/ai-gateway.controller';
import { AiGatewayService } from '../../src/ai/gateway/ai-gateway.service';
import { AiGatewayConfig } from '../../src/ai/gateway/ai-gateway.config';
import { AiRedactionService } from '../../src/ai/gateway/ai-redaction.service';
import { PrivateContextService } from '../../src/ai/gateway/private-context.service';
import { AiProviderRegistry } from '../../src/ai/gateway/providers/provider-registry';
import { StubProviderAdapter } from '../../src/ai/gateway/providers/stub-provider.adapter';
import type { AnthropicProviderAdapter } from '../../src/ai/gateway/providers/anthropic-provider.adapter';
import { CapabilityMaterializerRegistry } from '../../src/ai/gateway/materialisers/capability-materialiser.registry';
import {
  COACH_MESSAGE_CAPABILITY,
  CoachMessageMaterializer,
} from '../../src/ai/gateway/materialisers/coach-message.materialiser';
import { CoachWearableMessageMaterializer } from '../../src/ai/gateway/materialisers/coach-wearable-message.materialiser';
import { AiConsentService } from '../../src/ai-consent/ai-consent.service';
import { CLIENT_AI_CONSENT_VERSION } from '../../src/ai-consent/ai-consent.constants';
import { AiEgressService } from '../../src/ai-egress/ai-egress.service';
import { AiConsentRequiredException } from '../../src/ai-egress/ai-consent-required.exception';
import { InsightCacheService } from '../../src/wearables/insights/insight-cache.service';
import { WearableInsightsService } from '../../src/wearables/insights/wearable-insights.service';
import { WearableInsightsController } from '../../src/wearables/insights/wearable-insights.controller';
import { IngestionService } from '../../src/wearables/ingestion/ingestion.service';
import { AutoMessageAssetResolver } from '../../src/packages/asset-resolvers/auto-message.resolver';
import { ResolverSubCoachScope } from '../../src/packages/asset-resolvers/sub-coach-scope.helper';

const DB_URL = liveTestDatabaseUrl();
if (!DB_URL && process.env.CI === 'true') {
  throw new Error('roman-draft-mark-rls: CI=true but no TEST_DATABASE_URL; refusing to skip.');
}

const ENV = {
  FEATURE_AI_CONSENT_LEDGER_ENABLED: 'true',
  AI_GATEWAY_ENABLED: 'true',
  AI_GATEWAY_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'live-test',
  AI_GATEWAY_CAPABILITIES: COACH_MESSAGE_CAPABILITY,
  AI_GATEWAY_REQUIRE_APPROVAL: COACH_MESSAGE_CAPABILITY,
};
const MODEL_TEXT = 'Great week. Keep the evening walks going.';
const SUGGESTED = 'Your sleep held steady all week. Keep the wind-down routine.';

(DB_URL ? describe : describe.skip)('The Roman mark: only a server-written Roman draft, written while the client allowed AI help', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const db = cast<PrismaService>(prisma);
  // Coach K and client A share the thread; B is K's other client; coach L and L's client C are another tenant.
  const [K, A, B, L, C] = Array.from({ length: 5 }, () => randomUUID());
  const role: Record<string, 'coach' | 'student'> = { [K]: 'coach', [A]: 'student', [B]: 'student', [L]: 'coach', [C]: 'student' };
  const req = (id: string) => cast<AuthedRequest>({ user: { id, role: role[id], coach_id: null }, headers: {} });
  const welcome = { jobId: randomUUID(), lease: randomUUID() };
  const legacyDraft = randomUUID();
  const savedEnv = { ...process.env };

  const quiet = async () => undefined;
  const consent = new AiConsentService(db);
  const egress = new AiEgressService(consent);
  const messaging = new MessagingService(db, cast({ pingChat: quiet }), cast({ capture: quiet }),
    cast({ emit: quiet }), cast({ emit: quiet }), cast({ write: quiet }), cast({ invalidateForUser: quiet }));
  const coachApi = new CoachMessagingController(messaging, cast({}), cast({}));
  const clientApi = new ClientMessagingController(messaging, cast({}), cast({}));
  const approvals = new AiApprovalService(db, cast({ write: quiet }), new CapabilityMaterializerRegistry([
    new CoachMessageMaterializer(db, messaging), new CoachWearableMessageMaterializer(db, messaging)]));
  const model = cast<AnthropicProviderAdapter>({ name: 'anthropic', complete: async () => ({
    provider: 'anthropic', model: 'live-test', text: MODEL_TEXT, enabled: true, promptTokenEstimate: 1, responseTokenEstimate: 1 }) });
  const gateway = new AiGatewayService(db, new AiGatewayConfig(), new AiRedactionService(),
    new AiProviderRegistry(new StubProviderAdapter(), model), egress);
  const gatewayApi = new AiGatewayController(gateway, approvals, new PrivateContextService(db));
  const cache = new InsightCacheService(db);
  const wearableApi = new WearableInsightsController(new WearableInsightsService(db, gateway, cache, egress), approvals, db);
  const ingestion = new IngestionService(db);
  const watch = randomUUID();
  const scope = new ResolverSubCoachScope(
    cast({ canAccessClient: async () => true, getHeadCoachIdForSubCoach: async () => null }));
  const autoMessage = new AutoMessageAssetResolver(messaging, scope, db);

  type Sent = { messageId: string; draftId: string | null };
  /** POST /ai/gateway/invoke as coach `who` for a Roman reply to A; returns the draft id. */
  const askRoman = async (who: string, extra: { proposed_action?: Record<string, unknown> } = {}) =>
    (await gatewayApi.invoke(req(who), { capability: COACH_MESSAGE_CAPABILITY, message: 'Draft a reply.', subject_user_id: A, ...extra }))
      .approval.draft_id;
  /** PATCH /ai/gateway/drafts/:id approved, as coach `who`. */
  const decide = async (who: string, draftId: string): Promise<Sent> =>
    ({ draftId, messageId: String((await gatewayApi.decide(req(who), draftId, { decision: 'approved' })).materialised_ref) });
  const romanReply = async () => decide(K, String(await askRoman(K)));
  /** POST /v1/wearables/insights/approve as K. */
  const wearable = (bucket: WearableMetricBucket, action: 'approve' | 'edit',
    draft_body = action === 'edit' ? 'Edited: keep the wind-down going.' : SUGGESTED) => async (): Promise<Sent> => {
    const out = await wearableApi.approveInsight(req(K), { client_id: A, bucket, draft_body, action });
    const row = await prisma.aiActionDraft.findUniqueOrThrow({ where: { id: out.draft_id } });
    return { draftId: out.draft_id, messageId: String(row.materialised_ref) };
  };
  /** A's watch syncs a night's sleep through the real ingest path just before `step`. */
  const synced = (step: () => Promise<Sent>) => async (): Promise<Sent> => {
    await ingestion.ingest([{ userId: A, connectionId: watch, provider: WearableProvider.OURA,
      metric: WearableMetricType.SLEEP_TOTAL_MIN, bucket: WearableMetricBucket.SLEEP_RECOVERY, value: 450, unit: 'min',
      startAt: new Date(Date.now() - 8 * 3_600_000), endAt: new Date() }]);
    return step();
  };
  /** A withdraws AI help just before `step`, then grants it again for the later paths. */
  const withdrawn = <T>(step: () => Promise<T>) => async (): Promise<T> => {
    await consent.withdraw(A);
    try {
      return await step();
    } finally {
      await consent.grant(A, { version: CLIENT_AI_CONSENT_VERSION });
    }
  };
  const plain = (send: () => Promise<{ id: string }>) => async (): Promise<Sent> => ({ messageId: (await send()).id, draftId: null });
  const refused = (attempt: () => Promise<unknown>) => async (): Promise<null> => {
    await attempt();
    return null;
  };
  // A send body that names a draft id, as an outsider would try (the API pipe already refuses unknown fields).
  const forged = (body: string) =>
    cast<CreateMessageDto>({ body, ai_draft_id: randomUUID(), aiDraftId: randomUUID() });
  const voice = { url: `${process.env.SUPABASE_URL}/storage/v1/object/public/voice-notes/${K}/n.m4a`,
    duration_sec: 30, size_bytes: 200_000, content_type: 'audio/m4a' };
  let pendingK = '';

  // The rule's list: every writer of a coach-thread message, and what its row must carry. 'marked' = the
  // approved draft's id; 'unmarked' = sent, ai_draft_id null; any REFUSED key = that refusal, no draft and no message.
  const MISMATCH = 'WEARABLE_SUGGESTION_MISMATCH';
  const REFUSED = { 400: BadRequestException, 403: ForbiddenException, ai_consent_required: AiConsentRequiredException,
    WEARABLE_SUGGESTION_MISMATCH: BadRequestException };
  const SPACES = 'wearable approve whose body is Roman\'s suggestion with extra spaces (sends the stored text)';
  type Expect = 'marked' | 'unmarked' | keyof typeof REFUSED;
  const PATHS: Array<[string, Expect, () => Promise<Sent | null>]> = [
    ['Roman reply draft (the model\'s own text), approved', 'marked', romanReply],
    ['wearable insight, sent as Roman suggested', 'marked', wearable(WearableMetricBucket.SLEEP_RECOVERY, 'approve')],
    [SPACES, 'marked', wearable(WearableMetricBucket.SLEEP_RECOVERY, 'approve', `  ${SUGGESTED}\n`)],
    ['wearable insight, edited before sending (S-08)', 'marked', wearable(WearableMetricBucket.SLEEP_RECOVERY, 'edit')],
    ['Roman reply invoke with the coach\'s own proposed_action', 400,
      refused(() => askRoman(K, { proposed_action: { clientId: A, body: 'My own words.' } }))],
    ['stored draft holding caller text (no server mark), approved', 'unmarked', () => decide(K, legacyDraft)],
    ['wearable approve with no stored Roman suggestion', MISMATCH, wearable(WearableMetricBucket.HEALTH_FITNESS, 'approve')],
    ['wearable approve whose body is not Roman\'s stored suggestion', MISMATCH,
      wearable(WearableMetricBucket.SLEEP_RECOVERY, 'approve', 'My own words.')],
    ['wearable insight sent as Roman suggested after the client\'s watch syncs', 'marked',
      synced(wearable(WearableMetricBucket.SLEEP_RECOVERY, 'approve'))],
    ['Roman reply draft written while AI help was on, sent after it is withdrawn', 'marked', async () => {
      const draftId = String(await askRoman(K));
      return withdrawn(() => decide(K, draftId))();
    }],
    ['wearable insight Roman wrote while AI help was on, sent after it is withdrawn', 'marked',
      withdrawn(wearable(WearableMetricBucket.SLEEP_RECOVERY, 'approve'))],
    ['Roman reply draft asked for after AI help is withdrawn', 'ai_consent_required', withdrawn(refused(() => askRoman(K)))],
    ['another coach approves this coach\'s Roman draft', 403, refused(() => decide(L, pendingK))],
    ['another coach sends with this coach\'s Roman draft id', 403,
      refused(() => messaging.sendAsCoach(L, C, { body: 'Hi' }, { aiDraftId: pendingK }))],
    ['same coach sends with a Roman draft about another of his clients', 403,
      refused(() => messaging.sendAsCoach(K, B, { body: 'Hi' }, { aiDraftId: pendingK }))],
    ['coach composer, typed, body names a draft id', 'unmarked', plain(() => coachApi.send(req(K), A, forged('Hi')))],
    ['coach composer, voice note', 'unmarked', plain(() => coachApi.send(req(K), A, { voice }))],
    ['coach welcome', 'unmarked', plain(() => messaging.sendAsCoach(K, A, { body: 'Welcome' }, { welcome }))],
    ['package auto-message', 'unmarked', async () => ({ draftId: null, messageId: (await autoMessage.materialise(
      { coachId: K, clientId: A, assetId: randomUUID(), displayCaption: 'Week 2' })).materialisedRef })],
    ['client reply, body names a draft id', 'unmarked', plain(() => clientApi.send(req(A), forged('Thanks')))],
  ];
  const outcome = new Map<string, { sent?: Sent; error?: unknown; drafts: number; messages: number }>();
  const counts = async () => [
    await prisma.aiActionDraft.count({ where: { tenant_coach_id: { in: [K, L] } } }),
    await prisma.coachMessage.count({ where: { client_id: { in: [A, B, C] } } }),
  ];
  const messageIds = () => [...outcome.values()].flatMap((o) => (o.sent ? [o.sent.messageId] : []));
  const mark = (path: string, expected: Expect) => (expected === 'marked' ? outcome.get(path)?.sent?.draftId : null);

  /** Rows and draft ids `who` reads as role authenticated (no row-security bypass). */
  const readAs = (who: string, ids: string[]) => prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE authenticated');
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_id', $1, true)`, who);
    await tx.$executeRawUnsafe(`SELECT set_config('app.current_user_role', $1, true)`, role[who]);
    const [{ bypass }] = await tx.$queryRaw<{ bypass: boolean }[]>`
      SELECT "rolbypassrls" AS "bypass" FROM pg_roles WHERE "rolname" = current_user`;
    const rows = await tx.$queryRaw<{ id: string; ai_draft_id: string | null; body: string | null }[]>`
      SELECT "id", "ai_draft_id", "body" FROM "CoachMessage" WHERE "id" = ANY(${ids}::text[])`;
    return { bypass, rows };
  });

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    for (const [id, coach_id] of [[K, null], [L, null], [A, K], [B, K], [C, L]] as Array<[string, string | null]>) {
      await prisma.user.create({
        data: { id, supabase_id: id, email: `roman-mark-${id}`, name: 'RLS person', role: role[id], coach_id },
      });
    }
    await consent.grant(A, { version: CLIENT_AI_CONSENT_VERSION });
    await prisma.wearableConnection.create({ data: { id: watch, user_id: A, provider: WearableProvider.OURA } });
    // Roman's stored suggestion for K about A's sleep (the wearable insight panel shows it).
    await cache.set('coach', A, WearableMetricBucket.SLEEP_RECOVERY, {
      observation: 'Sleep held steady.', hypothesis: 'The routine is working.', suggested_action: 'Keep it going.',
      suggested_message_draft: SUGGESTED, confidence_level: 'fairly_sure', source_metrics: ['STEPS'],
    }, { modelUsed: 'live-test', promptVersion: 'live-test' }, K);
    // A draft stored before this rule with the caller's own text (no server mark).
    await prisma.aiActionDraft.create({ data: { id: legacyDraft, capability: COACH_MESSAGE_CAPABILITY,
      tenant_coach_id: K, subject_user_id: A, payload: { clientId: A, body: 'My own words.' } } });
    pendingK = String(await askRoman(K));
    await prisma.coachWelcomeMessageJob.create({
      data: { id: welcome.jobId, client_id: A, coach_id: K, completed_at: new Date(), fire_at: new Date(),
        status: 'sending', lease_token: welcome.lease },
    });
    for (const [path, , send] of PATHS) {
      const [d0, m0] = await counts();
      let sent: Sent | undefined;
      let error: unknown;
      try {
        sent = (await send()) ?? undefined;
      } catch (err) {
        error = err;
      }
      const [d1, m1] = await counts();
      outcome.set(path, { sent, error, drafts: d1 - d0, messages: m1 - m0 });
    }
  });
  afterAll(async () => {
    process.env = savedEnv;
    await prisma.$disconnect();
  });

  it.each(PATHS.map(([path, expected]) => ({ path, expected })))('$path: $expected', async ({ path, expected }) => {
    const out = outcome.get(path)!;
    if (expected !== 'marked' && expected !== 'unmarked') {
      expect(out.error).toBeInstanceOf(REFUSED[expected]);
      if (expected === MISMATCH) expect((out.error as BadRequestException).getResponse()).toEqual({ error: MISMATCH });
      expect([out.drafts, out.messages]).toEqual([0, 0]);
      return;
    }
    expect(out.error).toBeUndefined();
    expect(out.messages).toBe(1);
    const id = out.sent!.messageId;
    const want = { bypass: false, rows: [expect.objectContaining({ id, ai_draft_id: mark(path, expected) })] };
    expect(await readAs(K, [id])).toEqual(want);
    expect(await readAs(A, [id])).toEqual(want);
  });

  it('the server writes the text: the model\'s reply, and Roman\'s stored suggestion for an approve with extra spaces', async () => {
    const body = async (path: string) => (await readAs(K, [outcome.get(path)!.sent!.messageId])).rows.map((r) => r.body);
    expect([await body(PATHS[0][0]), await body(SPACES)]).toEqual([[MODEL_TEXT], [SUGGESTED]]);
  });

  it('the sync expired Roman\'s stored suggestion (the next read makes a new one) and kept its text', async () => {
    const key = ['coach', A, WearableMetricBucket.SLEEP_RECOVERY, K] as const;
    expect(await cache.get(...key)).toBeNull();
    expect(await cache.getEvenIfStale(...key)).toMatchObject({ suggested_message_draft: SUGGESTED });
  });

  it.each(['false', 'true'])('GET /messages and GET /coach/clients/:id/messages return each draft id (v2 %s)', async (v2) => {
    process.env.FEATURE_MESSAGING_CORE_V2 = v2;
    const marks = (rows: Array<{ id: string; ai_draft_id: string | null }>) =>
      Object.fromEntries(rows.map((m) => [m.id, m.ai_draft_id]));
    const expected = Object.fromEntries(PATHS.flatMap(([path, want]) => {
      const sent = outcome.get(path)?.sent;
      return sent ? [[sent.messageId, mark(path, want) ?? null]] : [];
    }));
    expect(marks(await clientApi.listThread(req(A), {}))).toEqual(expected);
    expect(marks(await coachApi.listThread(req(K), A, {}))).toEqual(expected);
  });

  it('another coach gets 404 on the thread; another client reads only their own, empty thread', async () => {
    await expect(coachApi.listThread(req(L), A, {})).rejects.toThrow(NotFoundException);
    expect(await clientApi.listThread(req(C), {})).toEqual([]);
  });

  it('row layer: the coach and client read every row; another coach, another client and the coach\'s other client read none', async () => {
    const ids = messageIds();
    const count = async (who: string) => {
      const { bypass, rows } = await readAs(who, ids);
      return { bypass, rows: rows.length };
    };
    expect([await count(K), await count(A)]).toEqual([{ bypass: false, rows: ids.length }, { bypass: false, rows: ids.length }]);
    expect([await count(L), await count(C), await count(B)]).toEqual(Array(3).fill({ bypass: false, rows: 0 }));
  });
});
