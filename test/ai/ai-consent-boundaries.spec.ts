// R2 — data-subject AI consent at EVERY provider boundary (owner ruling #5,
// Sol audit of #601 A2 + the "ungated boundaries" open risk).
//
// Three groups:
//   1. Refusal: every path that sends a NAMED client's personal data to a
//      model provider refuses (structured 403, fail closed) when the client
//      has no live current-version grant or when no gate is bound — and the
//      provider is never reached. Paths: AnthropicAdapter, AiGatewayService
//      (pre-check + in-provider withdrawal), churn-intervention drafts,
//      community AI triage (batch filter), AiService.chat.
//   2. Pins for the provider calls that are NOT consent-gated because they
//      carry no client personal data: the coach daily brief (planted client
//      names never reach the prompt), first-win (win type only) and the public
//      diagnostic (scores + catalogue text only; never name / email / age).
//   3. Inventory: every src file that imports a provider SDK is on a reviewed
//      allowlist. A new importer fails this test until it is reviewed here.
//
// No network: both SDK modules are mocked; every provider double records
// calls so "never called" is asserted, not assumed.

const sdkCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => {
  const ctor = jest.fn().mockImplementation(() => ({ messages: { create: sdkCreate } }));
  return { __esModule: true, default: ctor };
});

const openaiCreate = jest.fn();
jest.mock('openai', () => {
  const ctor = jest.fn().mockImplementation(() => ({
    chat: { completions: { create: openaiCreate } },
  }));
  return { __esModule: true, default: ctor };
});

import * as fs from 'fs';
import * as path from 'path';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  AI_ERROR_CLIENT_CONSENT_REQUIRED,
  AI_ERROR_CONSENT_GATE_UNAVAILABLE,
  assertSubjectAiConsent,
  consentedAiSubjects,
  isSubjectConsentRefusal,
} from '../../src/ai/adapters/ai-subject-consent.gate';
import { AnthropicAdapter } from '../../src/ai/adapters/anthropic.adapter';
import { AiGatewayService } from '../../src/ai/gateway/ai-gateway.service';
import { AiGatewayConfig } from '../../src/ai/gateway/ai-gateway.config';
import { AiRedactionService } from '../../src/ai/gateway/ai-redaction.service';
import { AiProviderRegistry } from '../../src/ai/gateway/providers/provider-registry';
import { StubProviderAdapter } from '../../src/ai/gateway/providers/stub-provider.adapter';
import { AnthropicProviderAdapter } from '../../src/ai/gateway/providers/anthropic-provider.adapter';
import { ChurnInterventionService } from '../../src/coach/command-center/churn-intervention.service';
import { AiTriageService } from '../../src/community/ai-triage/ai-triage.service';
import { TriageCacheService } from '../../src/community/ai-triage/triage-cache.service';
import { AiService } from '../../src/ai/ai.service';
import { AIGuardrailsService } from '../../src/ai/ai-guardrails.service';
import { RomanConsentService } from '../../src/roman/consent/roman-consent.service';
import {
  CoachBriefService,
  buildBriefPrompt,
  buildHeadCoachSystemPrompt,
  buildSoloCoachSystemPrompt,
} from '../../src/coach/brief/coach-brief.service';
import type { BriefContext, BriefContextHeadCoach } from '../../src/coach/brief/coach-brief.types';
import { FirstWinService } from '../../src/first-win/first-win.service';
import { AiRoadmapService } from '../../src/diagnostic/ai-roadmap.service';
import { loadCatalog } from '../../src/diagnostic/question-catalog';
import type {
  DiagnosticBuckets,
  DiagnosticScores,
  SubmitDiagnosticDto,
} from '../../src/diagnostic/diagnostic.dto';
import { consentGateFor } from '../helpers/ai-consent-gate.double';

// ─── shared doubles ───────────────────────────────────────────────────────

const CLIENT = 'client-0000-4000-8000-000000000001';
const OTHER_CLIENT = 'client-0000-4000-8000-000000000002';
const COACH = 'coach-0000-4000-8000-000000000001';

/**
 * A dependency double that records every property access. Any read of a
 * delegate (prisma.checkIn, ptm.getLatestPrediction, …) is logged, so a test
 * can prove nothing past the refusal point was touched.
 */
function recorder(label: string, touched: string[]): any {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return undefined; // not a thenable
        touched.push(`${label}.${String(prop)}`);
        return recorder(`${label}.${String(prop)}`, touched);
      },
      apply() {
        return undefined;
      },
    },
  );
}

function configWith(values: Record<string, string>): ConfigService {
  return new ConfigService(values);
}

async function refusalOf(p: Promise<unknown>): Promise<{ status: number; code: unknown }> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ForbiddenException);
    const e = err as ForbiddenException;
    const body = e.getResponse();
    const code = typeof body === 'object' && body !== null ? Reflect.get(body, 'code') : undefined;
    return { status: e.getStatus(), code };
  }
  throw new Error('expected a 403 consent refusal, but the call resolved');
}

beforeEach(() => {
  sdkCreate.mockReset();
  openaiCreate.mockReset();
});

// ─── 0. the shared gate helper ───────────────────────────────────────────

describe('assertSubjectAiConsent / consentedAiSubjects (shared fail-closed gate)', () => {
  it('no gate bound → 403 AI_CONSENT_GATE_UNAVAILABLE', async () => {
    expect(await refusalOf(assertSubjectAiConsent(null, CLIENT, 'x'))).toEqual({
      status: 403,
      code: AI_ERROR_CONSENT_GATE_UNAVAILABLE,
    });
  });

  it('blank subject on a gated path → 403 (refuse rather than send)', async () => {
    const gate = consentGateFor([CLIENT]);
    expect((await refusalOf(assertSubjectAiConsent(gate, '  ', 'x'))).code).toBe(
      AI_ERROR_CONSENT_GATE_UNAVAILABLE,
    );
    expect(gate.assertAiConsent).not.toHaveBeenCalled();
  });

  it('gate refusal is normalised to 403 CLIENT_AI_CONSENT_REQUIRED and recognised as a refusal', async () => {
    const gate = consentGateFor([]);
    let caught: unknown;
    try {
      await assertSubjectAiConsent(gate, CLIENT, 'x');
    } catch (e) {
      caught = e;
    }
    expect(isSubjectConsentRefusal(caught)).toBe(true);
    expect((await refusalOf(assertSubjectAiConsent(gate, CLIENT, 'x'))).code).toBe(
      AI_ERROR_CLIENT_CONSENT_REQUIRED,
    );
  });

  it('a non-403 gate error (database down) propagates unchanged and is not a "refusal"', async () => {
    const gate = consentGateFor([]);
    gate.assertAiConsent.mockRejectedValueOnce(new Error('db down'));
    await expect(assertSubjectAiConsent(gate, CLIENT, 'x')).rejects.toThrow('db down');
    expect(isSubjectConsentRefusal(new Error('db down'))).toBe(false);
  });

  it('batch form: no gate → nobody; otherwise only consented ids (deduped, blanks dropped)', async () => {
    expect(await consentedAiSubjects(undefined, [CLIENT])).toEqual(new Set());
    const gate = consentGateFor([CLIENT]);
    const out = await consentedAiSubjects(gate, [CLIENT, OTHER_CLIENT, CLIENT, ' ']);
    expect(out).toEqual(new Set([CLIENT]));
    expect(gate.consentedSubjects).toHaveBeenCalledWith([CLIENT, OTHER_CLIENT]);
  });
});

describe('RomanConsentService.consentedSubjects (the bound gate, batch form)', () => {
  it('keeps only live grants for the CURRENT version; revoked, stale and absent are excluded', async () => {
    const svcProbe = new RomanConsentService(recorder('prisma', []), recorder('audit', []));
    const current = svcProbe.currentVersion();
    const t0 = new Date('2026-09-01T00:00:00Z');
    const t1 = new Date('2026-09-02T00:00:00Z');
    const findMany = jest.fn(async () => [
      { user_id: 'live', granted_at: t0, revoked_at: null, consent_version: current },
      { user_id: 'regranted', granted_at: t1, revoked_at: t0, consent_version: current },
      { user_id: 'revoked', granted_at: t0, revoked_at: t1, consent_version: current },
      { user_id: 'stale', granted_at: t0, revoked_at: null, consent_version: 'client-ai-v1' },
    ]);
    const prisma: any = { aiProcessingConsent: { findMany } };
    const svc = new RomanConsentService(prisma, recorder('audit', []));
    const out = await svc.consentedSubjects(['live', 'regranted', 'revoked', 'stale', 'absent', 'live']);
    expect(out).toEqual(new Set(['live', 'regranted']));
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(await svc.consentedSubjects([])).toEqual(new Set());
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

// ─── 1. refusal at every client-data boundary ───────────────────────────

describe('AnthropicAdapter — refuses a named client without consent; SDK never called', () => {
  function adapter(gate: any) {
    const prisma: any = { aICallLog: { create: jest.fn(async () => ({})) } };
    return new AnthropicAdapter(configWith({ ANTHROPIC_API_KEY: 'test-key' }), prisma, undefined, gate);
  }

  it.each([
    ['no grant', consentGateFor([]), AI_ERROR_CLIENT_CONSENT_REQUIRED],
    ['no gate bound', null, AI_ERROR_CONSENT_GATE_UNAVAILABLE],
  ])('%s → structured 403 on complete() and completeStructured()', async (_l, gate, code) => {
    const a = adapter(gate);
    expect(
      await refusalOf(a.complete({ system: 's', user: 'u' }, { capability: 'workout_program', clientId: CLIENT })),
    ).toEqual({ status: 403, code });
    expect(
      await refusalOf(
        a.completeStructured(
          { system: 's', user: 'u' },
          (raw: unknown) => raw,
          { capability: 'workout_program', clientId: CLIENT },
        ),
      ),
    ).toEqual({ status: 403, code });
    expect(sdkCreate).not.toHaveBeenCalled();
  });
});

describe('AiGatewayService — named client checked before any non-stub provider call; refusal is 403, never a stub', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      AI_GATEWAY_ENABLED: 'true',
      AI_GATEWAY_PROVIDER: 'anthropic',
      AI_GATEWAY_CAPABILITIES: '*',
      AI_GATEWAY_REQUIRE_APPROVAL: 'none.capability',
      ANTHROPIC_API_KEY: 'test-key',
    };
  });
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  function prismaDouble(): any {
    return {
      aiRequestAudit: { create: jest.fn(async ({ data }: any) => ({ id: 'audit-1', ...data })) },
      aiActionDraft: { create: jest.fn(async ({ data }: any) => ({ id: 'draft-1', ...data })) },
    };
  }

  function gatewayWith(gate: any) {
    const realProvider: any = {
      name: 'anthropic',
      complete: jest.fn(async () => ({ provider: 'anthropic', model: 'm', text: 'ok', enabled: true })),
    };
    const stub = new StubProviderAdapter();
    const stubSpy = jest.spyOn(stub, 'complete');
    const registry = new AiProviderRegistry(stub, realProvider);
    const prisma = prismaDouble();
    const svc = new AiGatewayService(
      prisma,
      new AiGatewayConfig(),
      new AiRedactionService(),
      registry,
      undefined,
      undefined,
      gate,
    );
    return { svc, realProvider, stubSpy, prisma };
  }

  it.each([
    ['client self-chat, no grant', { id: CLIENT, role: 'student' }, undefined, consentGateFor([]), AI_ERROR_CLIENT_CONSENT_REQUIRED],
    ['coach request naming a client, no grant', { id: COACH, role: 'coach' }, CLIENT, consentGateFor([]), AI_ERROR_CLIENT_CONSENT_REQUIRED],
    ['coach request naming a client, no gate bound', { id: COACH, role: 'coach' }, CLIENT, undefined, AI_ERROR_CONSENT_GATE_UNAVAILABLE],
  ])('%s → structured 403, provider and stub both untouched', async (_l, requester, subjectUserId, gate, code) => {
    const { svc, realProvider, stubSpy } = gatewayWith(gate);
    expect(
      await refusalOf(
        svc.invoke({
          capability: 'chat.client_self',
          requester,
          subjectUserId,
          userMessage: 'how am I doing',
          systemPrompt: 'ctx',
        }),
      ),
    ).toEqual({ status: 403, code });
    expect(realProvider.complete).not.toHaveBeenCalled();
    expect(stubSpy).not.toHaveBeenCalled();
  });

  it('consented client → provider called once with the subject forwarded for the adapter re-check', async () => {
    const gate = consentGateFor([CLIENT]);
    const { svc, realProvider } = gatewayWith(gate);
    await svc.invoke({
      capability: 'chat.client_self',
      requester: { id: CLIENT, role: 'student' },
      userMessage: 'hi',
      systemPrompt: 'ctx',
    });
    expect(gate.assertAiConsent).toHaveBeenCalledWith(CLIENT);
    expect(realProvider.complete).toHaveBeenCalledTimes(1);
    expect(realProvider.complete.mock.calls[0][0].subjectUserId).toBe(CLIENT);
  });

  it('coach request with no named client is not subject-gated (carries no single client context)', async () => {
    const gate = consentGateFor([]);
    const { svc, realProvider } = gatewayWith(gate);
    await svc.invoke({
      capability: 'coach.summary',
      requester: { id: COACH, role: 'coach' },
      userMessage: 'hi',
      systemPrompt: 'ctx',
    });
    expect(gate.assertAiConsent).not.toHaveBeenCalled();
    expect(realProvider.complete).toHaveBeenCalledTimes(1);
  });

  it('the stub provider never leaves the process, so it is not gated (gateway disabled, no gate bound)', async () => {
    process.env.AI_GATEWAY_ENABLED = 'false';
    const { svc, realProvider } = gatewayWith(undefined);
    const res = await svc.invoke({
      capability: 'chat.client_self',
      requester: { id: CLIENT, role: 'student' },
      userMessage: 'hi',
      systemPrompt: 'ctx',
    });
    expect(res.provider).toBe('stub');
    expect(realProvider.complete).not.toHaveBeenCalled();
  });

  it('grant withdrawn between the gateway pre-check and the adapter call → 403 surfaces, no stub fallback, SDK untouched', async () => {
    const gate = consentGateFor([CLIENT]);
    // First check (gateway) passes; the adapter's own re-check refuses.
    gate.assertAiConsent
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new ForbiddenException({ code: 'ROMAN_CONSENT_REQUIRED', reason: 'revoked' });
      });
    const prismaLog: any = { aICallLog: { create: jest.fn(async () => ({})) } };
    const adapter = new AnthropicAdapter(configWith({ ANTHROPIC_API_KEY: 'k' }), prismaLog, undefined, gate);
    const state: any = { isReady: () => true };
    const provider = new AnthropicProviderAdapter(adapter, state);
    const stub = new StubProviderAdapter();
    const stubSpy = jest.spyOn(stub, 'complete');
    const svc = new AiGatewayService(
      prismaDouble(),
      new AiGatewayConfig(),
      new AiRedactionService(),
      new AiProviderRegistry(stub, provider),
      undefined,
      undefined,
      gate,
    );
    expect(
      await refusalOf(
        svc.invoke({
          capability: 'chat.client_self',
          requester: { id: CLIENT, role: 'student' },
          userMessage: 'hi',
          systemPrompt: 'ctx',
        }),
      ),
    ).toEqual({ status: 403, code: AI_ERROR_CLIENT_CONSENT_REQUIRED });
    expect(gate.assertAiConsent).toHaveBeenCalledTimes(2);
    expect(sdkCreate).not.toHaveBeenCalled();
    expect(stubSpy).not.toHaveBeenCalled();
  });
});

describe('ChurnInterventionService.generateChurnDraft — consent checked before draft row, check-in read or provider call', () => {
  const IDEMPOTENCY = '33333333-3333-4333-8333-333333333333';

  it.each([
    ['no grant', consentGateFor([]), AI_ERROR_CLIENT_CONSENT_REQUIRED],
    ['no gate bound', undefined, AI_ERROR_CONSENT_GATE_UNAVAILABLE],
  ])('%s → structured 403; nothing past the roster check is touched', async (_l, gate, code) => {
    const touched: string[] = [];
    const findFirst = jest.fn(async () => ({ id: CLIENT, name: 'Planted Clientname' }));
    const prisma: any = new Proxy(
      { user: { findFirst } },
      {
        get(target, prop) {
          if (prop === 'user') return target.user;
          if (prop === 'then') return undefined;
          return recorder(`prisma.${String(prop)}`, touched);
        },
      },
    );
    const fakeAnthropic: any = { messages: { create: jest.fn() } };
    const svc = new ChurnInterventionService(
      prisma,
      recorder('ptm', touched),
      configWith({ ANTHROPIC_API_KEY: 'k' }),
      recorder('notifications', touched),
      fakeAnthropic,
      gate,
    );
    expect(
      await refusalOf(svc.generateChurnDraft(COACH, CLIENT, { idempotency_key: IDEMPOTENCY })),
    ).toEqual({ status: 403, code });
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(touched).toEqual([]); // no ptm read, no churnIntervention.create, no dailyCheckIn read
    expect(fakeAnthropic.messages.create).not.toHaveBeenCalled();
    expect(sdkCreate).not.toHaveBeenCalled();
  });
});

describe('AiTriageService — only consented authors\u2019 items reach the provider', () => {
  const COHORT = 'a1111111-1111-4111-8111-111111111111';
  const t = new Date(Date.now() - 60_000);

  function build(gate: any) {
    const repo = {
      coachedCohortIds: jest.fn(async () => [COHORT]),
      unansweredMessages: jest.fn(async () => [
        {
          id: '11111111-1111-4111-8111-111111111111',
          cohort_id: COHORT,
          body: 'consented-body-alpha',
          created_at: t,
          sender: { id: CLIENT, name: 'Consented Author', role: 'student' },
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          cohort_id: COHORT,
          body: 'withheld-body-bravo',
          created_at: t,
          sender: { id: OTHER_CLIENT, name: 'Withheld Author', role: 'student' },
        },
      ]),
      unansweredPosts: jest.fn(async () => []),
    };
    const access = {
      findCohort: jest.fn(async () => ({ id: COHORT, name: 'Cohort A' })),
      findCohortsByIds: jest.fn(async () => [{ id: COHORT, name: 'Cohort A' }]),
    };
    const gateway = {
      invoke: jest.fn(async () => ({
        requestId: 'r',
        auditId: 'a',
        approvalDraftId: null,
        approvalRequired: false,
        approvalStatus: 'not_required',
        enabled: true,
        provider: 'anthropic',
        model: 'm',
        reply: 'not json',
        redactionsApplied: {},
        provenance: [],
        draftMode: false,
      })),
    };
    const gatewayArg: any = gateway;
    const repoArg: any = repo;
    const accessArg: any = access;
    const svc = new AiTriageService(gatewayArg, repoArg, accessArg, new TriageCacheService(), gate);
    return { svc, gateway };
  }
  const coachUser: any = { id: COACH, role: 'coach', name: 'Coach Person' };

  it('mixed consent: the withheld author\u2019s name and text never appear in any provider call', async () => {
    const { svc, gateway } = build(consentGateFor([CLIENT]));
    await svc.generateForCoach(coachUser);
    expect(gateway.invoke).toHaveBeenCalled();
    const sent = JSON.stringify(gateway.invoke.mock.calls);
    expect(sent).toContain('consented-body-alpha');
    expect(sent).not.toContain('withheld-body-bravo');
    expect(sent).not.toContain('Withheld Author');
    expect(sent).not.toContain(OTHER_CLIENT);
  });

  it.each([
    ['nobody consented', consentGateFor([])],
    ['no gate bound (fail closed)', undefined],
  ])('%s → typed empty triage, provider never called', async (_l, gate) => {
    const { svc, gateway } = build(gate);
    const res = await svc.generateForCoach(coachUser);
    expect(gateway.invoke).not.toHaveBeenCalled();
    expect(res.source_item_ids).toEqual([]);
  });
});

describe('AiService.chat — consent asserted before context build or any provider', () => {
  it.each([
    ['no grant', consentGateFor([]), AI_ERROR_CLIENT_CONSENT_REQUIRED],
    ['no gate bound', undefined, AI_ERROR_CONSENT_GATE_UNAVAILABLE],
  ])('%s → structured 403; context service, Perplexity and Anthropic untouched', async (_l, gate, code) => {
    const touched: string[] = [];
    const prev = process.env.PERPLEXITY_API_KEY;
    process.env.PERPLEXITY_API_KEY = 'test-key';
    try {
      const anthropic: any = { complete: jest.fn() };
      const state: any = { isReady: () => true };
      const svc = new AiService(
        recorder('prisma', touched),
        recorder('contextSvc', touched),
        new AIGuardrailsService(),
        recorder('analytics', touched),
        anthropic,
        state,
        gate,
      );
      expect(await refusalOf(svc.chat(CLIENT, 'how am I doing', []))).toEqual({ status: 403, code });
      expect(touched).toEqual([]);
      expect(openaiCreate).not.toHaveBeenCalled();
      expect(anthropic.complete).not.toHaveBeenCalled();
    } finally {
      process.env.PERPLEXITY_API_KEY = prev;
    }
  });
});

// ─── 2. pins: ungated provider calls carry no client personal data ──────

const PLANTED_CLIENT_NAMES = ['Zephyrine Quillfeather', 'Bartholomew Okonkwo-Vance', 'Marisol Etxeberria'];
const PLANTED_PREVIEW = 'my knee hurts and I skipped meds';

describe('Coach daily brief — planted client names never reach the prompt', () => {
  function plantedPrisma(): any {
    const [a, b, c] = PLANTED_CLIENT_NAMES;
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ count: BigInt(1) }])
      .mockResolvedValueOnce([{ user_id: 'cl-b', user_name: b, delta_lbs: 6.5 }]);
    return {
      user: {
        findUnique: jest.fn(async () => ({ name: 'Avery Coachperson' })),
        findMany: jest.fn(async () => [{ id: 'cl-c', name: c }]),
      },
      checkIn: { findMany: jest.fn(async () => [{ user_id: 'cl-a' }]) },
      clientWorkoutAssignment: {
        findMany: jest.fn(async () => [
          { id: 'w1', client_id: 'cl-a', client: { name: a }, workout_plan: { name: 'Plan' } },
        ]),
        count: jest.fn(async () => 2),
      },
      clientPurchase: {
        aggregate: jest.fn(async () => ({ _sum: { amount_cents: 12000 }, _count: { _all: 1 } })),
        count: jest.fn(async () => 1),
      },
      $queryRaw: queryRaw,
      coachMessage: {
        findMany: jest.fn(async () => [
          { client_id: 'cl-c', client: { name: c }, body: PLANTED_PREVIEW, created_at: new Date() },
        ]),
      },
    };
  }

  it('solo brief: aggregation sees the planted names (action items), the Anthropic payload carries none', async () => {
    const create = jest.fn(async () => ({
      content: [
        {
          type: 'text',
          text: "Avery, we've had a steady morning. One client checked in and we collected a payment. We're chasing one failed payment for you. Here's what needs your quick approval:",
        },
      ],
    }));
    const client: any = { messages: { create } };
    const svc = new CoachBriefService(plantedPrisma(), configWith({}), client);
    const agg = await svc['aggregateSoloContext'](COACH, ['cl-a', 'cl-b', 'cl-c'], 'UTC', '2026-09-30');

    // The plant reached the service (so the absence below is meaningful) …
    const detail = JSON.stringify([agg.pendingWorkouts, agg.flaggedWeightLogs, agg.unreadThreads, agg.missingCheckinClients]);
    for (const n of PLANTED_CLIENT_NAMES) expect(detail).toContain(n);
    // … but the prompt context holds counts only.
    const ctxJson = JSON.stringify(agg.context);
    for (const n of PLANTED_CLIENT_NAMES) expect(ctxJson).not.toContain(n);

    await svc.callClaude(agg.context);
    expect(create).toHaveBeenCalled();
    const payload = JSON.stringify(create.mock.calls);
    for (const n of PLANTED_CLIENT_NAMES) {
      expect(payload).not.toContain(n);
      for (const part of n.split(/[\s-]+/)) expect(payload).not.toContain(part);
    }
    expect(payload).not.toContain(PLANTED_PREVIEW);
    for (const id of ['cl-a', 'cl-b', 'cl-c']) expect(payload).not.toContain(id);
    expect(sdkCreate).not.toHaveBeenCalled();
  });

  it('prompt builders ignore extra client fields smuggled onto the context object (solo + head coach)', () => {
    const solo: BriefContext = {
      brief_mode: 'solo_coach',
      date: '2026-09-30',
      checked_in_today: 1,
      missed_checkin: 2,
      workouts_pending_approval: 1,
      workouts_approved_today: 0,
      paid_today_count: 1,
      revenue_today_cents: 5000,
      renewals_upcoming_7d: 0,
      dunning_in_progress: 1,
      weight_logs_flagged: 1,
      unread_messages: 1,
      coach_name: 'Avery Coachperson',
      coach_first_name: 'Avery',
      roster_size: 3,
    };
    const soloPlanted = { ...solo, clients: PLANTED_CLIENT_NAMES.map((name) => ({ name })), client_name: PLANTED_CLIENT_NAMES[0] };
    const head: BriefContextHeadCoach = {
      brief_mode: 'head_coach',
      date: '2026-09-30',
      coach_name: 'Avery Coachperson',
      coach_first_name: 'Avery',
      team_size: 2,
      team_clients_total: 9,
      new_clients_last_24h: 1,
      total_revenue_today_cents: 5000,
      team_revenue_30d_cents: 90000,
      mrr_projected_cents: 40000,
      paid_today_count: 1,
      dunning_in_progress: 1,
      dunning_amount_cents: 3000,
      sub_coach_highlights: [{ coach_name: 'Sub Coachperson', new_clients_24h: 1, active_clients: 4 }],
    };
    const headPlanted = { ...head, missing_clients: PLANTED_CLIENT_NAMES, unread: [{ client_name: PLANTED_CLIENT_NAMES[1] }] };
    const text = [buildBriefPrompt(soloPlanted), buildBriefPrompt(headPlanted), buildSoloCoachSystemPrompt(), buildHeadCoachSystemPrompt()].join('\n');
    for (const n of PLANTED_CLIENT_NAMES) expect(text).not.toContain(n);
  });

  it('BriefContext / BriefContextHeadCoach declare no free-text field other than coach names, date and mode', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/coach/brief/coach-brief.types.ts'), 'utf8');
    for (const iface of ['BriefContext', 'BriefContextHeadCoach', 'SubCoachHighlight']) {
      const m = new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`).exec(src);
      expect(m).not.toBeNull();
      const stringFields = [...m![1].matchAll(/^\s*([a-z_]+)\??:\s*string;/gm)].map((x) => x[1]).sort();
      expect(stringFields.every((f) => ['coach_first_name', 'coach_name', 'date'].includes(f))).toBe(true);
    }
  });
});

describe('First win — prompt carries the win type only', () => {
  it('no name, email, user id or any profile field reaches the provider', async () => {
    const prev = process.env.PERPLEXITY_API_KEY;
    process.env.PERPLEXITY_API_KEY = 'test-key';
    try {
      openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'Your first meal log sets a baseline. Keep logging daily.' } }] });
      const row = {
        first_win_completed_at: null,
        name: PLANTED_CLIENT_NAMES[0],
        email: 'planted.person@example.test',
        goal: 'planted-goal-text',
      };
      const prisma: any = {
        user: { findUniqueOrThrow: jest.fn(async () => row), update: jest.fn(async () => row) },
      };
      const svc = new FirstWinService(prisma);
      await svc.complete(CLIENT, 'first_meal');
      expect(openaiCreate).toHaveBeenCalledTimes(1);
      const payload = JSON.stringify(openaiCreate.mock.calls);
      for (const s of [PLANTED_CLIENT_NAMES[0], 'planted.person@example.test', 'planted-goal-text', CLIENT]) {
        expect(payload).not.toContain(s);
      }
      // The only per-request content is the win label.
      expect(payload).toContain('logged their first meal');
      // And the service never asked the database for profile fields.
      for (const call of prisma.user.findUniqueOrThrow.mock.calls) {
        expect(Object.keys(call[0].select)).toEqual(['first_win_completed_at']);
      }
    } finally {
      process.env.PERPLEXITY_API_KEY = prev;
    }
  });
});

describe('Public diagnostic roadmap — scores and catalogue text only', () => {
  it('submitter name, email, age and source never reach the provider', async () => {
    const prevKey = process.env.PERPLEXITY_API_KEY;
    const prevEnabled = process.env.DIAGNOSTIC_AI_ENABLED;
    process.env.PERPLEXITY_API_KEY = 'test-key';
    delete process.env.DIAGNOSTIC_AI_ENABLED;
    try {
      openaiCreate.mockResolvedValue({ choices: [{ message: { content: 'a\n\nb\n\nc\n\nd' } }], usage: { total_tokens: 10 } });
      const prisma: any = { aiRoadmap: { upsert: jest.fn(async () => ({})) } };
      const svc = new AiRoadmapService(prisma);
      const body: SubmitDiagnosticDto = {
        email: 'planted.submitter@example.test',
        name: PLANTED_CLIENT_NAMES[2],
        age: 47,
        source: 'planted-source-tag',
        answers: loadCatalog().questions.map((q) => ({ question_id: q.id, answer: (q.id % 5) + 1 })),
      };
      const scores: DiagnosticScores = {
        income: 60, body: 55, lifestyle: 50, income_raw: 45, body_raw: 33, lifestyle_raw: 32, overall_raw: 110,
      };
      const buckets: DiagnosticBuckets = {
        income: 'moving', body: 'moving', lifestyle: 'stuck', overall: 'moving', overall_headline: 'Moving',
      };
      await svc.generateAndPersist('sub-1', scores, buckets, body);
      expect(openaiCreate).toHaveBeenCalledTimes(1);
      const payload = JSON.stringify(openaiCreate.mock.calls);
      for (const s of ['planted.submitter@example.test', PLANTED_CLIENT_NAMES[2], 'planted-source-tag', 'sub-1']) {
        expect(payload).not.toContain(s);
      }
      expect(payload).not.toMatch(/\b47\b(?!%)/);
      expect(payload).toContain('Income Architecture: 60%');
    } finally {
      process.env.PERPLEXITY_API_KEY = prevKey;
      if (prevEnabled === undefined) delete process.env.DIAGNOSTIC_AI_ENABLED;
      else process.env.DIAGNOSTIC_AI_ENABLED = prevEnabled;
    }
  });
});

// ─── 3. inventory: provider SDK importers are reviewed ──────────────────

/**
 * Every src file that imports a model-provider SDK, with the reason it is
 * allowed. Adding an importer means adding a row here in review: either it
 * routes a named client through the consent gate, or it is pinned above as
 * carrying no client personal data.
 */
const REVIEWED_PROVIDER_SDK_IMPORTERS: Record<string, string> = {
  'src/ai/adapters/anthropic.adapter.ts': 'coach-AI adapter; assertSubjectAiConsent on every attempt when clientId is set',
  'src/ai/ai.service.ts': 'retired /ai/chat path (410); chat() asserts consent before context build',
  'src/ai/coach/coach-ai-state.service.ts': 'boot readiness probe; fixed 4-token prompt, no user data',
  'src/coach/brief/coach-brief.service.ts': 'coach daily brief; counts + coach names only (pinned above)',
  'src/coach/command-center/churn-intervention.service.ts': 'churn drafts; consent asserted before draft / check-in read / call',
  'src/diagnostic/ai-roadmap.service.ts': 'public diagnostic; scores + catalogue text only (pinned above)',
  'src/first-win/first-win.service.ts': 'first-win message; win type only (pinned above)',
  // Added by #598 (R1, stacked): fixed 'ping' probe, no user data. Listed here
  // so this PR stays green before and after #598 lands (see the stale check).
  'src/roman/model/roman-model-health.service.ts': 'Roman boot / runtime model probe; fixed "ping" prompt, no user data',
  'src/roman/anthropic-client.provider.ts': 'Roman client factory; send route guarded by AiProcessingConsentGuard + assertAiConsent',
  'src/roman/roman.service.ts': 'Roman (type-only import); assertAiConsent in the send handler',
};

const PROVIDER_SDK_PACKAGES = [
  '@anthropic-ai/sdk',
  'openai',
  '@google/genai',
  '@google/generative-ai',
  '@mistralai/mistralai',
  'cohere-ai',
  'groq-sdk',
];

function walk(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|js|mts|cts)$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name) && !p.includes(`${path.sep}__tests__${path.sep}`)) {
      out.push(p);
    }
  }
  return out;
}

describe('Provider SDK inventory', () => {
  it('every src file importing a provider SDK is on the reviewed allowlist (and no existing row is stale)', () => {
    const root = path.join(__dirname, '../..');
    const pkgAlt = PROVIDER_SDK_PACKAGES.map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
    const importRe = new RegExp(
      `(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s+)['"\`](?:${pkgAlt})(?:/[^'"\`]*)?['"\`]`,
    );
    const importers = walk(path.join(root, 'src'), [])
      .filter((f) => importRe.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f).split(path.sep).join('/'))
      .sort();
    // Every importer is reviewed …
    const unreviewed = importers.filter((f) => !(f in REVIEWED_PROVIDER_SDK_IMPORTERS));
    expect(unreviewed).toEqual([]);
    // … and no row is stale: a listed file that exists must still import an
    // SDK. (A listed file may be absent only while its stacked PR is open.)
    const stale = Object.keys(REVIEWED_PROVIDER_SDK_IMPORTERS).filter(
      (f) => fs.existsSync(path.join(root, f)) && !importers.includes(f),
    );
    expect(stale).toEqual([]);
  });

  it('the detector itself catches static, type-only, dynamic and require forms', () => {
    const pkgAlt = PROVIDER_SDK_PACKAGES.map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
    const importRe = new RegExp(
      `(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s+)['"\`](?:${pkgAlt})(?:/[^'"\`]*)?['"\`]`,
    );
    for (const sample of [
      "import Anthropic from '@anthropic-ai/sdk';",
      "import type X from '@anthropic-ai/sdk/resources';",
      "const m = await import('openai');",
      "const o = require(\"openai\");",
      "import 'groq-sdk';",
    ]) {
      expect(importRe.test(sample)).toBe(true);
    }
    expect(importRe.test("// provider is 'openai' compatible")).toBe(false);
  });
});
