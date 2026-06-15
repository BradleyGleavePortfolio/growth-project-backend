/**
 * Unit tests for WearablePromptsService (v3-4 wearable-aware coaching prompts).
 *
 * Mocks every collaborator (repository, access, consent, fallback, generator,
 * insights, analytics, prisma) so these run with NO DB and NO Supabase. They
 * pin the slice's 50-Failures defenses, in generation order:
 *
 *   - Ownership: a coach who does not own the client is 403 before anything.
 *   - Consent re-check: a missing live consent skips ALL metrics 'no_consent'
 *     and NEVER persists a prompt.
 *   - Degraded connector: a non-CONNECTED gate skips ALL metrics
 *     'degraded_connector' and NEVER persists.
 *   - Cooldown: an in-window pre-check skips 'cooldown'; a concurrent-insert
 *     P2002 is mapped to 'cooldown' (no throw).
 *   - Sample-id recording: a persisted prompt carries the REAL sample ids the
 *     generator surfaced (audit trail, brief test 4).
 *   - No PHI leak: the analytics capture payload carries counts only — never a
 *     raw metric value, prompt text, or client name.
 *   - Coach-only writes: dismiss / act-on are a SINGLE atomic, coach-scoped repo
 *     call (RLS-safe coachId re-assert; PR #399 F5). A prompt the coach does not
 *     own (or that does not exist) surfaces a 404 from the repo — never a 403,
 *     never a leak. Dismiss/act-on of an already-acted prompt is idempotent.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, WearableMetricType } from '@prisma/client';
import { WearablePromptsService } from '../wearable-prompts.service';
import { WEARABLE_INSIGHTS_CONSENT_SCOPE } from '../wearable-prompts.dto';
import type { BuiltPrompt, MetricTrend } from '../prompt-generator.service';
import { makeCoachUser } from './test-user.factory';

const WS = '11111111-1111-1111-1111-111111111111';
const COACH_ID = '22222222-2222-2222-2222-222222222222';
const CLIENT_ID = '33333333-3333-3333-3333-333333333333';
const SAMPLE_ID = '44444444-4444-4444-4444-444444444444';
const PROMPT_ID = '55555555-5555-5555-5555-555555555555';

const coach = makeCoachUser(COACH_ID, 'coach');

type RepoMock = {
  findRecentSampleIds: jest.Mock;
  isWithinCooldown: jest.Mock;
  createPromptWithSources: jest.Mock;
  listForCoach: jest.Mock;
  findOneForCoach: jest.Mock;
  markDismissed: jest.Mock;
  markActedOn: jest.Mock;
};

function makeP2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function trend(): MetricTrend {
  return {
    metric: WearableMetricType.HRV_MS,
    baseline: 100,
    recent: 85,
    changePct: -15,
    unit: 'ms',
    samples: [{ id: SAMPLE_ID, value: 85 }],
  };
}

function built(): BuiltPrompt {
  return {
    metricKey: WearableMetricType.HRV_MS,
    promptText:
      "Sarah's HRV has dropped 15% over the last 14 days — consider checking in.",
    sources: [
      { sampleId: SAMPLE_ID, metricKey: WearableMetricType.HRV_MS, observedValue: 85 },
    ],
  };
}

function persistedPrompt() {
  return {
    id: PROMPT_ID,
    workspaceId: WS,
    coachId: COACH_ID,
    clientId: CLIENT_ID,
    metricKey: WearableMetricType.HRV_MS,
    promptText: built().promptText,
    generatedAt: new Date('2026-06-14T00:00:00.000Z'),
    dismissedAt: null,
    actedOnAt: null,
    sources: [
      {
        id: 'src-1',
        promptId: PROMPT_ID,
        sampleId: SAMPLE_ID,
        metricKey: WearableMetricType.HRV_MS,
        observedValue: new Prisma.Decimal(85),
      },
    ],
  };
}

function build(overrides?: {
  consent?: boolean;
  gateOk?: boolean;
  withinCooldown?: boolean;
  trendResult?: MetricTrend | null;
  createImpl?: jest.Mock;
}) {
  const repo: RepoMock = {
    findRecentSampleIds: jest.fn(),
    isWithinCooldown: jest.fn().mockResolvedValue(overrides?.withinCooldown ?? false),
    createPromptWithSources:
      overrides?.createImpl ?? jest.fn().mockResolvedValue(persistedPrompt()),
    listForCoach: jest.fn().mockResolvedValue([]),
    findOneForCoach: jest.fn(),
    markDismissed: jest.fn().mockResolvedValue(persistedPrompt()),
    markActedOn: jest.fn().mockResolvedValue(persistedPrompt()),
  };
  const access = {
    isWorkspaceCoach: jest.fn().mockResolvedValue(true),
  };
  const consent = {
    coachCanAccess: jest.fn().mockResolvedValue(overrides?.consent ?? true),
  };
  const fallback = {
    gate: jest
      .fn()
      .mockResolvedValue(
        overrides?.gateOk === false
          ? { ok: false, reason: 'disconnected' }
          : { ok: true, reason: 'none' },
      ),
  };
  const generator = {
    computeTrend: jest
      .fn()
      .mockResolvedValue(
        overrides?.trendResult === undefined ? trend() : overrides.trendResult,
      ),
    build: jest.fn().mockReturnValue(built()),
  };
  const insights = {
    assertCoachOwnsClient: jest.fn().mockResolvedValue(undefined),
  };
  const analytics = { capture: jest.fn() };
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ name: 'Sarah Lee' }) },
  };

  const service = new WearablePromptsService(
    repo as never,
    access as never,
    consent as never,
    fallback as never,
    generator as never,
    insights as never,
    analytics as never,
    prisma as never,
  );
  return {
    service,
    repo,
    access,
    consent,
    fallback,
    generator,
    insights,
    analytics,
    prisma,
  };
}

describe('WearablePromptsService.generate', () => {
  const ORIGINAL_ENV = process.env.FEATURE_COMMUNITY_TELEMETRY;
  afterEach(() => {
    process.env.FEATURE_COMMUNITY_TELEMETRY = ORIGINAL_ENV;
    jest.clearAllMocks();
  });

  it('403s when the coach does not own the client (IDOR)', async () => {
    const { service, insights, consent } = build();
    insights.assertCoachOwnsClient.mockRejectedValueOnce(
      new ForbiddenException('Client is not assigned to this coach'),
    );
    await expect(
      service.generate(coach, WS, {
        clientId: CLIENT_ID,
        metricKey: WearableMetricType.HRV_MS,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(consent.coachCanAccess).not.toHaveBeenCalled();
  });

  it('re-checks consent live and skips no_consent without persisting', async () => {
    const { service, consent, repo } = build({ consent: false });
    const res = await service.generate(coach, WS, {
      clientId: CLIENT_ID,
      metricKey: WearableMetricType.HRV_MS,
    });
    expect(consent.coachCanAccess).toHaveBeenCalledWith(
      COACH_ID,
      CLIENT_ID,
      WEARABLE_INSIGHTS_CONSENT_SCOPE,
      'coach',
    );
    expect(res.generated).toHaveLength(0);
    expect(res.skipped).toEqual([
      { metricKey: WearableMetricType.HRV_MS, reason: 'no_consent' },
    ]);
    expect(repo.createPromptWithSources).not.toHaveBeenCalled();
  });

  it('skips degraded_connector on a non-CONNECTED gate without persisting', async () => {
    const { service, repo, generator } = build({ gateOk: false });
    const res = await service.generate(coach, WS, {
      clientId: CLIENT_ID,
      metricKey: WearableMetricType.HRV_MS,
    });
    expect(res.generated).toHaveLength(0);
    expect(res.skipped).toEqual([
      { metricKey: WearableMetricType.HRV_MS, reason: 'degraded_connector' },
    ]);
    expect(generator.computeTrend).not.toHaveBeenCalled();
    expect(repo.createPromptWithSources).not.toHaveBeenCalled();
  });

  it('skips cooldown when the pre-check is within the window', async () => {
    const { service, repo } = build({ withinCooldown: true });
    const res = await service.generate(coach, WS, {
      clientId: CLIENT_ID,
      metricKey: WearableMetricType.HRV_MS,
    });
    expect(res.skipped).toEqual([
      { metricKey: WearableMetricType.HRV_MS, reason: 'cooldown' },
    ]);
    expect(repo.createPromptWithSources).not.toHaveBeenCalled();
  });

  it('maps a concurrent-insert P2002 to a cooldown skip (no throw)', async () => {
    const createImpl = jest.fn().mockRejectedValue(makeP2002());
    const { service } = build({ createImpl });
    const res = await service.generate(coach, WS, {
      clientId: CLIENT_ID,
      metricKey: WearableMetricType.HRV_MS,
    });
    expect(res.skipped).toEqual([
      { metricKey: WearableMetricType.HRV_MS, reason: 'cooldown' },
    ]);
  });

  it('persists a prompt that records the REAL sample id (audit trail)', async () => {
    const { service } = build();
    const res = await service.generate(coach, WS, {
      clientId: CLIENT_ID,
      metricKey: WearableMetricType.HRV_MS,
    });
    expect(res.generated).toHaveLength(1);
    expect(res.generated[0]!.sources).toEqual([
      { sampleId: SAMPLE_ID, metricKey: WearableMetricType.HRV_MS, observedValue: 85 },
    ]);
  });

  it('skips no_signal when the generator returns no trend', async () => {
    const { service, repo } = build({ trendResult: null });
    const res = await service.generate(coach, WS, {
      clientId: CLIENT_ID,
      metricKey: WearableMetricType.HRV_MS,
    });
    expect(res.skipped).toEqual([
      { metricKey: WearableMetricType.HRV_MS, reason: 'no_signal' },
    ]);
    expect(repo.createPromptWithSources).not.toHaveBeenCalled();
  });

  it('emits telemetry with counts only — no PHI (value / name / text)', async () => {
    process.env.FEATURE_COMMUNITY_TELEMETRY = 'true';
    const { service, analytics } = build();
    await service.generate(coach, WS, {
      clientId: CLIENT_ID,
      metricKey: WearableMetricType.HRV_MS,
    });
    expect(analytics.capture).toHaveBeenCalledTimes(1);
    const [, , payload] = analytics.capture.mock.calls[0]!;
    expect(payload).toEqual({
      workspace_id: WS,
      generated_count: 1,
      skipped_count: 0,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('85'); // no observed value
    expect(serialized).not.toContain('Sarah'); // no client name
    expect(serialized).not.toContain('HRV'); // no metric copy
  });
});

describe('WearablePromptsService coach-only writes', () => {
  afterEach(() => jest.clearAllMocks());

  it('dismiss makes a SINGLE coach-scoped repo call (RLS-safe coachId re-assert)', async () => {
    const { service, repo } = build();
    const view = await service.dismiss(coach, PROMPT_ID);
    // One atomic, coach-scoped write — coachId is re-asserted INSIDE the repo's
    // UPDATE ... WHERE so the authorizing read and the write can't drift apart.
    expect(repo.markDismissed).toHaveBeenCalledTimes(1);
    const [promptIdArg, coachIdArg] = repo.markDismissed.mock.calls[0]!;
    expect(promptIdArg).toBe(PROMPT_ID);
    expect(coachIdArg).toBe(COACH_ID);
    expect(view.id).toBe(PROMPT_ID);
  });

  it('act-on makes a SINGLE coach-scoped repo call (RLS-safe coachId re-assert)', async () => {
    const { service, repo } = build();
    const view = await service.actOn(coach, PROMPT_ID);
    expect(repo.markActedOn).toHaveBeenCalledTimes(1);
    const [promptIdArg, coachIdArg] = repo.markActedOn.mock.calls[0]!;
    expect(promptIdArg).toBe(PROMPT_ID);
    expect(coachIdArg).toBe(COACH_ID);
    expect(view.id).toBe(PROMPT_ID);
  });

  it('404s dismiss when the prompt is foreign / non-existent (repo throws — never 403)', async () => {
    const { service, repo } = build();
    // Repo's coach-scoped UPDATE ... WHERE matched zero rows AND no coach-owned
    // row exists → NotFound (existence never leaks).
    repo.markDismissed.mockRejectedValueOnce(new NotFoundException());
    await expect(service.dismiss(coach, PROMPT_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s act-on when the prompt is foreign / non-existent (repo throws — never 403)', async () => {
    const { service, repo } = build();
    repo.markActedOn.mockRejectedValueOnce(new NotFoundException());
    await expect(service.actOn(coach, PROMPT_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('dismiss is idempotent — returns the already-dismissed row unchanged', async () => {
    const { service, repo } = build();
    const already = { ...persistedPrompt(), dismissedAt: new Date('2026-06-13T00:00:00.000Z') };
    // Repo absorbs the no-op (its UPDATE matched zero active rows but the row
    // exists & is coach-owned) and returns the existing row with its original
    // dismissedAt — the service surfaces it as a normal 200 view.
    repo.markDismissed.mockResolvedValueOnce(already);
    const view = await service.dismiss(coach, PROMPT_ID);
    expect(repo.markDismissed).toHaveBeenCalledTimes(1);
    expect(view.dismissedAt).toBe('2026-06-13T00:00:00.000Z');
  });
});
