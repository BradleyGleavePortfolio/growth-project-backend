/**
 * COACH-DRAFT-CAP-BE (operator call 21:3x PST 11-27, undo "drafts stay off"):
 * Roman's coach message drafts (the check-in reply, the Home win and reach-out
 * notes, the win-back) all ask the gateway for draft.coach_message, which only
 * reaches the model when AI_GATEWAY_CAPABILITIES names it. The closed set gains
 * two values with that task; the checked-in manifest declares one of them.
 *
 * The real AiGatewayService, AiGatewayConfig, AiRedactionService and
 * AiProviderRegistry with the stub, a faked Anthropic adapter and a faked
 * database, over the real AiEgressService. Every value is taken from ENV_RULES
 * by its exact spelling, and the declared value from the checked-in manifest.
 * On the declared value this spec asserts only what holds for the third and the
 * fourth value alike, so it stays green when ALL-ON moves the file to the fourth.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ENV_RULES } from '../src/common/env-validation';
import { AiGatewayService, type AiGatewayRequest } from '../src/ai/gateway/ai-gateway.service';
import { AiGatewayConfig } from '../src/ai/gateway/ai-gateway.config';
import { AiRedactionService } from '../src/ai/gateway/ai-redaction.service';
import { AiProviderRegistry } from '../src/ai/gateway/providers/provider-registry';
import { StubProviderAdapter } from '../src/ai/gateway/providers/stub-provider.adapter';
import { ROMAN_MESSAGE_SOURCE } from '../src/ai/gateway/roman-message-draft';
import { AiConsentService } from '../src/ai-consent/ai-consent.service';
import { AiEgressService } from '../src/ai-egress/ai-egress.service';
import * as fem from '../scripts/fly-env/fly-env-manifest';
import { egressWithGrants, fakeOf, withTx } from './ai-egress/ai-egress.fakes';

const CREATE = 'draft.create_workout_plan';
const EDIT = 'draft.edit_workout_plan';
const DRAFT = 'draft.coach_message';
const INSIGHT_CLIENT = 'wearable_insight.client';
const INSIGHT_COACH = 'wearable_insight.coach';
/** The four closed values, spelled and ordered as the operator's R1 writes them. */
const R1 = [
  `${CREATE},${EDIT}`,
  `${CREATE},${EDIT},${INSIGHT_CLIENT},${INSIGHT_COACH}`,
  `${CREATE},${EDIT},${DRAFT}`,
  `${CREATE},${EDIT},${INSIGHT_CLIENT},${INSIGHT_COACH},${DRAFT}`,
];
const VALUES = ENV_RULES.find((r) => r.name === 'AI_GATEWAY_CAPABILITIES')?.values ?? [];
/** A value as ENV_RULES holds it; '' when the closed set lacks that exact spelling. */
const fromRules = (spelled: string) => VALUES.find((v) => v === spelled) ?? '';
const [V1, V2, V3, V4] = R1.map(fromRules);
const DECLARED = fem.parseManifestText(
  readFileSync(join(__dirname, '..', '.github/fly-env-desired-state.json'), 'utf8'),
).flags.AI_GATEWAY_CAPABILITIES;

/** Every task a caller passes to the gateway (src and the phone), plus made-up neighbours. */
const UNIVERSE = [
  CREATE, EDIT, DRAFT, INSIGHT_CLIENT, INSIGHT_COACH,
  'draft.coach_wearable_message', 'draft.assign_workout', 'draft.assign_meal_plan', 'draft.send_notification',
  'draft.meal_plan_change', 'draft.client_facing_claim', 'draft.client_message', 'flag.escalation',
  'community_ai_triage', 'coach_brief_draft', 'client_path_summary', 'client_path_change', 'program_draft',
  'check_in_summary', 'food_log_explain', 'client_chat', 'chat.client_self', 'chat.client_coach',
  'weekly_insight', 'workout_program', 'meal_plan', 'insight', 'client_chat_fallback',
  'roman.chat', 'roman.memory', 'roman.playbook', 'draft.coach_message_v2', 'draft', '*',
];
/** What each value lets through (FEATURE_MWB_AI_LIVE_CREATE on); only draft.coach_message is new. */
const ALLOWED: Array<[string, string, string[]]> = [
  ['unset', '', []],
  ['the first value', R1[0], [CREATE, EDIT]],
  ['the second value', R1[1], [CREATE, EDIT, INSIGHT_CLIENT, INSIGHT_COACH]],
  ['the third value', R1[2], [CREATE, EDIT, DRAFT]],
  ['the fourth value', R1[3], [CREATE, EDIT, DRAFT, INSIGHT_CLIENT, INSIGHT_COACH]],
];

const COACH = 'coach-1';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const ROMAN_TEXT = 'Great week on the plan. How did the long run feel?';

function harness(capabilities: string, grantedClients: string[] = [CLIENT], egressOverride?: AiEgressService) {
  process.env.AI_GATEWAY_CAPABILITIES = capabilities;
  const created = { drafts: [] as Array<Record<string, unknown>>, audits: [] as Array<Record<string, unknown>> };
  const blocks: Array<{ blocker_id: string; blocked_id: string }> = [];
  const roster: Record<string, string> = { [CLIENT]: COACH };
  const prisma = withTx({
    aiRequestAudit: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { created.audits.push(data); return { id: 'audit-1', ...data }; }) },
    aiActionDraft: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { created.drafts.push(data); return { id: `draft-${created.drafts.length}`, ...data }; }),
      findMany: jest.fn(async () => []),
    },
    user: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] }; coach_id: string } }) =>
        where.id.in.filter((id) => roster[id] === where.coach_id).map((id) => ({ id }))),
    },
    subCoachAssignment: { findMany: jest.fn(async () => []) },
    userBlock: { findMany: jest.fn(async () => blocks) },
    coachMessage: { create: jest.fn() },
  });
  const budget = {
    resolveHeadCoachId: jest.fn(async (id: string) => id),
    canCharge: jest.fn(async () => ({ allowed: true, budget: { actual_used_cents: 0, total_actual_available_cents: 4000 } })),
    recordUsage: jest.fn(async () => ({ recorded: true })),
    getBudgetDto: jest.fn(),
  };
  const complete = jest.fn(async (req: { capability: string }) => ({
    text: ROMAN_TEXT, enabled: true, provider: 'anthropic', model: 'test-model', promptTokenEstimate: 10, responseTokenEstimate: 5, meta: { capability: req.capability },
  }));
  const registry = new AiProviderRegistry(new StubProviderAdapter(), fakeOf({ name: 'anthropic', complete }));
  const { egress, reader } = egressWithGrants(grantedClients);
  const config = new AiGatewayConfig();
  const svc = new AiGatewayService(
    fakeOf(prisma), config, new AiRedactionService(), registry, egressOverride ?? egress,
    fakeOf<NonNullable<ConstructorParameters<typeof AiGatewayService>[5]>>(budget),
  );
  return { svc, config, prisma, created, blocks, roster, budget, complete, reader };
}

const coachAsk = (extra: Partial<AiGatewayRequest> = {}): AiGatewayRequest => ({
  capability: DRAFT,
  requester: { id: COACH, role: 'coach' },
  subjectUserId: CLIENT,
  tenantCoachId: COACH,
  userMessage: 'Write a short, warm check-in from the coach to this client.',
  systemPrompt: 'context',
  ...extra,
});

describe('COACH-DRAFT-CAP-BE: production allow-list lets Roman write coach message drafts', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.AI_GATEWAY_ENABLED = 'true';
    process.env.AI_GATEWAY_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'test-only-not-a-key';
    process.env.FEATURE_MWB_AI_LIVE_CREATE = 'true';
    delete process.env.AI_GATEWAY_REQUIRE_APPROVAL;
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('5a: under the first value a coach draft is the stub: no model, no draft, no budget read, no debit, no consent read', async () => {
    expect(V1).toBe(R1[0]);
    const t = harness(V1);
    const out = await t.svc.invoke(coachAsk());
    expect(out).toMatchObject({ provider: 'stub', enabled: false, approvalDraftId: null });
    expect(out.reply).toMatch(/^\[ai-disabled\]/);
    for (const spy of [t.complete, t.prisma.aiActionDraft.create, t.budget.canCharge, t.budget.recordUsage]) expect(spy).not.toHaveBeenCalled();
    expect([t.reader.calls, t.reader.coachCalls]).toEqual([[], []]);
  });

  it('5b/5h: under the declared value Roman writes one pending draft, spends once, sends nothing', async () => {
    expect([V3, V4]).not.toContain('');
    expect([V3, V4]).toContain(DECLARED);
    const t = harness(DECLARED);
    const out = await t.svc.invoke(coachAsk());
    expect(t.complete).toHaveBeenCalledTimes(1);
    expect(t.complete).toHaveBeenCalledWith(expect.objectContaining({ capability: DRAFT }));
    expect(out).toMatchObject({ enabled: true, provider: 'anthropic', approvalRequired: true, approvalStatus: 'pending', approvalDraftId: 'draft-1', reply: ROMAN_TEXT });
    expect(t.created.drafts).toHaveLength(1);
    expect(t.created.drafts[0]).toMatchObject({ capability: DRAFT, status: 'pending', requester_id: COACH, subject_user_id: CLIENT, payload: { clientId: CLIENT, body: ROMAN_TEXT } });
    expect(t.created.drafts[0].provenance).toEqual(expect.arrayContaining([expect.objectContaining({ source: ROMAN_MESSAGE_SOURCE })]));
    expect(t.prisma.coachMessage.create).not.toHaveBeenCalled();
    expect(t.budget.canCharge).toHaveBeenCalledTimes(1);
    expect(t.budget.recordUsage).toHaveBeenCalledTimes(1);
    expect(t.budget.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ coachId: COACH, capability: DRAFT }));
    expect(t.reader.coachCalls).toEqual([COACH]);
  });

  it.each<[string, string, boolean, string[]]>([
    ["the coach's own AI grant withheld", 'coach_ai_consent_required', true, [CLIENT]],
    ["the client's box-2 grant withheld", 'ai_consent_required', false, []],
  ])('5c: under the third value, %s: 403 %s; no model call, no draft, no debit', async (_label, code, coachWithout, granted) => {
    expect(V3).toBe(R1[2]);
    const t = harness(V3, granted);
    if (coachWithout) t.reader.coachesWithout.add(COACH);
    await expect(t.svc.invoke(coachAsk())).rejects.toMatchObject({ status: 403, response: { code } });
    for (const spy of [t.complete, t.prisma.aiActionDraft.create, t.budget.recordUsage]) expect(spy).not.toHaveBeenCalled();
  });

  it('5c/Q4: under the third value with the consent ledger off, the real consent service reads no grant and the draft is refused', async () => {
    expect(V3).toBe(R1[2]);
    delete process.env.FEATURE_AI_CONSENT_LEDGER_ENABLED;
    // A database that would answer any read is never asked: the ledger switch is read first.
    const consent = new AiConsentService(fakeOf({}));
    expect(await consent.clientsWithAiConsent([CLIENT])).toEqual(new Set());
    const t = harness(V3, [CLIENT], new AiEgressService(consent));
    await expect(t.svc.invoke(coachAsk())).rejects.toMatchObject({ status: 403, response: { code: 'coach_ai_consent_required' } });
    for (const spy of [t.complete, t.prisma.aiActionDraft.create, t.budget.recordUsage]) expect(spy).not.toHaveBeenCalled();
  });

  it('5d: the third value keeps the wearable insight tasks off; the fourth allows them and still allows coach drafts', () => {
    expect([V3, V4]).toEqual([R1[2], R1[3]]);
    const { config } = harness(V3);
    for (const cap of [INSIGHT_CLIENT, INSIGHT_COACH]) expect([cap, config.resolve(cap).capabilityAllowed]).toEqual([cap, false]);
    expect(config.resolve(DRAFT)).toMatchObject({ enabled: true, capabilityAllowed: true });
    process.env.AI_GATEWAY_CAPABILITIES = V4;
    for (const cap of [INSIGHT_CLIENT, INSIGHT_COACH, DRAFT]) expect([cap, config.resolve(cap).capabilityAllowed]).toEqual([cap, true]);
  });

  it('5e: task by value: every value lets through exactly its named tasks; the new values differ from the old only by draft.coach_message', () => {
    expect(VALUES).toEqual(R1);
    const config = new AiGatewayConfig();
    const allowedAt = (value: string) => {
      process.env.AI_GATEWAY_CAPABILITIES = value;
      return UNIVERSE.filter((cap) => config.resolve(cap).capabilityAllowed);
    };
    for (const [label, value, expected] of ALLOWED) expect([label, allowedAt(value)]).toEqual([label, expected]);
    // '*' would let every task through, which is why the closed set never holds it.
    expect(allowedAt('*')).toEqual(UNIVERSE);
    const diff = (a: string[], b: string[]) => a.filter((c) => !b.includes(c));
    expect(diff(allowedAt(V3), allowedAt(V1))).toEqual([DRAFT]);
    expect(diff(allowedAt(V4), allowedAt(V2))).toEqual([DRAFT]);
    expect([diff(allowedAt(V1), allowedAt(V3)), diff(allowedAt(V2), allowedAt(V4))]).toEqual([[], []]);
  });

  it('5f: under the third value the role gate, the server-written rule, the block and the roster check still refuse before the model', async () => {
    expect(V3).toBe(R1[2]);
    const t = harness(V3);
    await expect(t.svc.invoke(coachAsk({ requester: { id: CLIENT, role: 'student' } }))).rejects.toMatchObject({ status: 403, response: { error: 'AI_DRAFT_ROLE_FORBIDDEN' } });
    await expect(t.svc.invoke(coachAsk({ proposedActionPayload: { clientId: CLIENT, body: 'My own words.' } }))).rejects.toMatchObject({ status: 400, response: { error: 'AI_DRAFT_PAYLOAD_SERVER_WRITTEN' } });
    for (const block of [{ blocker_id: COACH, blocked_id: CLIENT }, { blocker_id: CLIENT, blocked_id: COACH }]) {
      t.blocks.splice(0, 1, block);
      await expect(t.svc.invoke(coachAsk())).rejects.toMatchObject({ status: 403, response: { code: 'messaging.blocked' } });
    }
    t.blocks.splice(0);
    t.roster[CLIENT] = 'coach-9';
    await expect(t.svc.invoke(coachAsk())).rejects.toMatchObject({ status: 404, response: { code: 'client_not_found' } });
    expect([t.reader.calls, t.reader.coachCalls]).toEqual([[], []]);
    for (const spy of [t.complete, t.prisma.aiActionDraft.create, t.budget.canCharge, t.budget.recordUsage]) expect(spy).not.toHaveBeenCalled();
  });

  it.each(['the third value', 'the fourth value'])('5g: under %s the workout tasks follow FEATURE_MWB_AI_LIVE_CREATE as under the first', (label) => {
    const value = label === 'the third value' ? V3 : V4;
    expect(value).toBe(label === 'the third value' ? R1[2] : R1[3]);
    const config = new AiGatewayConfig();
    process.env.AI_GATEWAY_CAPABILITIES = value;
    expect([CREATE, EDIT].map((cap) => config.resolve(cap).capabilityAllowed)).toEqual([true, true]);
    process.env.FEATURE_MWB_AI_LIVE_CREATE = 'false';
    expect([CREATE, EDIT].map((cap) => config.resolve(cap).capabilityAllowed)).toEqual([false, false]);
    process.env.AI_GATEWAY_CAPABILITIES = V1;
    expect([CREATE, EDIT].map((cap) => config.resolve(cap).capabilityAllowed)).toEqual([false, false]);
  });

  it('6: the gateway status answer is the same under the first and the third value and never names draft.coach_message', () => {
    expect(V3).toBe(R1[2]);
    const statusAt = (value: string) => harness(value).svc.getStatus();
    const first = statusAt(V1);
    expect(statusAt(V3)).toEqual(first);
    expect(first.capabilities).not.toContain(DRAFT);
    expect(first.capabilities).toEqual([CREATE, EDIT]);
  });
});
