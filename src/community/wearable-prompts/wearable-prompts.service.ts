import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import { AnalyticsService } from '../../analytics/analytics.service';
import { ConsentService } from '../../consent/consent.service';
import { PrismaService } from '../../prisma.service';
import { WearableInsightsService } from '../../wearables/insights/wearable-insights.service';
import { COMMUNITY_TELEMETRY_EVENTS } from '../community-events';
import { CommunityAccessService } from '../community-access.service';
import { DegradedConnectorFallbackService } from './degraded-connector-fallback.service';
import { PromptGeneratorService } from './prompt-generator.service';
import {
  type GeneratePromptsBody,
  type GenerateResponse,
  GenerateResponseSchema,
  type ListPromptsQuery,
  type PromptListResponse,
  PromptListResponseSchema,
  type PromptView,
  PROMPT_METRIC_ALLOWLIST,
  type PromptMetricKey,
  WEARABLE_INSIGHTS_CONSENT_SCOPE,
} from './wearable-prompts.dto';
import {
  type PromptWithSources,
  WearablePromptsRepository,
} from './wearable-prompts.repository';

const FORBIDDEN = {
  error: 'forbidden',
  code: 'community.wearable_prompts.forbidden',
} as const;


/**
 * v3-4 wearable-aware coaching prompts (COACH-ONLY).
 *
 * Generation pipeline, in strict order (50-Failures defenses):
 *   1. Coach owns the workspace + the client (IDOR / ownership) — else 403.
 *   2. Consent RE-CHECK at generation time (NOT cached from a prior insight):
 *      the client must have granted the wearable-insights consent scope to
 *      this coach. Skip 'no_consent' otherwise.
 *   3. Degraded-connector gate: skip 'degraded_connector' unless the client
 *      has a CONNECTED connector (no stale data; fallback emits telemetry).
 *   4. 24h cooldown per (coach, client, metric) — pre-check + DB unique index
 *      (a concurrent insert raises P2002 → skip 'cooldown').
 *   5. Trend computation; skip 'no_data' / 'no_signal' when there is nothing
 *      worth surfacing.
 *   6. Persist prompt + REAL sample-id source rows in one transaction.
 *
 * Prompts are NEVER readable by a client (coach-only RLS + this service's
 * coach-scoped queries). Search results NEVER include wearable values
 * (different subsystem). Telemetry carries ids/counts/bounded reasons only.
 */
@Injectable()
export class WearablePromptsService {
  private readonly logger = new Logger(WearablePromptsService.name);

  constructor(
    private readonly repo: WearablePromptsRepository,
    private readonly access: CommunityAccessService,
    private readonly consent: ConsentService,
    private readonly fallback: DegradedConnectorFallbackService,
    private readonly generator: PromptGeneratorService,
    private readonly insights: WearableInsightsService,
    private readonly analytics: AnalyticsService,
    private readonly prisma: PrismaService,
  ) {}

  async generate(
    coach: Pick<User, 'id' | 'role'>,
    workspaceId: string,
    body: GeneratePromptsBody,
  ): Promise<GenerateResponse> {
    await this.assertCoachOwnsWorkspaceAndClient(coach, workspaceId, body.clientId);

    const now = new Date();
    const generated: PromptView[] = [];
    const skipped: GenerateResponse['skipped'] = [];

    // (2) Consent re-check at generation time — live, not cached.
    const consentGranted = await this.consent.coachCanAccess(
      coach.id,
      body.clientId,
      WEARABLE_INSIGHTS_CONSENT_SCOPE,
      coach.role,
    );
    if (!consentGranted) {
      for (const metric of this.metricsFor(body)) {
        skipped.push({ metricKey: metric, reason: 'no_consent' });
      }
      return this.finalize(generated, skipped, coach.id, workspaceId);
    }

    // (3) Degraded-connector gate — short-circuit ALL metrics on non-CONNECTED.
    const gate = await this.fallback.gate(workspaceId, coach.id, body.clientId);
    if (!gate.ok) {
      for (const metric of this.metricsFor(body)) {
        skipped.push({ metricKey: metric, reason: 'degraded_connector' });
      }
      return this.finalize(generated, skipped, coach.id, workspaceId);
    }

    const client = await this.prisma.user.findUnique({
      where: { id: body.clientId },
      select: { name: true },
    });
    const clientName = (client?.name ?? '').split(' ')[0] ?? '';

    for (const metric of this.metricsFor(body)) {
      // (4) Cooldown pre-check.
      if (await this.repo.isWithinCooldown(coach.id, body.clientId, metric, now)) {
        skipped.push({ metricKey: metric, reason: 'cooldown' });
        continue;
      }

      // (5) Trend.
      const trend = await this.generator.computeTrend(
        body.clientId,
        coach.id,
        metric,
        now,
      );
      if (!trend) {
        skipped.push({ metricKey: metric, reason: 'no_signal' });
        continue;
      }

      const built = this.generator.build(trend, clientName);
      if (built.sources.length === 0) {
        skipped.push({ metricKey: metric, reason: 'no_data' });
        continue;
      }

      // (6) Persist — the unique index is the authoritative cooldown race guard.
      try {
        const prompt = await this.repo.createPromptWithSources({
          workspaceId,
          coachId: coach.id,
          clientId: body.clientId,
          metricKey: metric,
          promptText: built.promptText,
          sources: built.sources,
        });
        generated.push(this.toView(prompt));
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          // Concurrent insert won the cooldown race — treat as cooldown skip.
          skipped.push({ metricKey: metric, reason: 'cooldown' });
          continue;
        }
        throw e;
      }
    }

    return this.finalize(generated, skipped, coach.id, workspaceId);
  }

  async list(
    coach: Pick<User, 'id' | 'role'>,
    workspaceId: string,
    query: ListPromptsQuery,
  ): Promise<PromptListResponse> {
    await this.assertCoachOwnsWorkspace(coach, workspaceId);
    const prompts = await this.repo.listForCoach({
      workspaceId,
      coachId: coach.id,
      clientId: query.clientId,
      includeDismissed: query.includeDismissed ?? false,
      limit: query.limit ?? 50,
    });
    return PromptListResponseSchema.parse({
      version: 1,
      prompts: prompts.map((p) => this.toView(p)),
    });
  }

  async dismiss(
    coach: Pick<User, 'id' | 'role'>,
    promptId: string,
  ): Promise<PromptView> {
    // Single atomic, coach-scoped write (RLS-safe coachId re-assert; PR #399 F5).
    // The repo maps a non-existent / foreign prompt to a 404 (never 403, never
    // leaks existence) and returns the fresh row with sources for the view.
    const fresh = await this.repo.markDismissed(promptId, coach.id, new Date());
    return this.toView(fresh);
  }

  async actOn(
    coach: Pick<User, 'id' | 'role'>,
    promptId: string,
  ): Promise<PromptView> {
    const fresh = await this.repo.markActedOn(promptId, coach.id, new Date());
    return this.toView(fresh);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private metricsFor(body: GeneratePromptsBody): PromptMetricKey[] {
    return body.metricKey
      ? [body.metricKey]
      : [...PROMPT_METRIC_ALLOWLIST];
  }

  private finalize(
    generated: PromptView[],
    skipped: GenerateResponse['skipped'],
    coachId: string,
    workspaceId: string,
  ): GenerateResponse {
    if (
      generated.length > 0 &&
      process.env.FEATURE_COMMUNITY_TELEMETRY === 'true'
    ) {
      this.analytics.capture(
        coachId,
        COMMUNITY_TELEMETRY_EVENTS.wearablePromptGenerated,
        {
          workspace_id: workspaceId,
          generated_count: generated.length,
          skipped_count: skipped.length,
        },
      );
    }
    this.logger.log({
      event: 'community_wearable_prompts_generated',
      workspace_id: workspaceId,
      coach_id: coachId,
      generated_count: generated.length,
      skipped_count: skipped.length,
    });
    return GenerateResponseSchema.parse({
      version: 1,
      generated,
      skipped,
    });
  }

  private async assertCoachOwnsWorkspace(
    coach: Pick<User, 'id' | 'role'>,
    workspaceId: string,
  ): Promise<void> {
    if (coach.role === 'owner') return;
    const isCoach = await this.access.isWorkspaceCoach(workspaceId, coach.id);
    if (!isCoach) throw new ForbiddenException(FORBIDDEN);
  }

  private async assertCoachOwnsWorkspaceAndClient(
    coach: Pick<User, 'id' | 'role'>,
    workspaceId: string,
    clientId: string,
  ): Promise<void> {
    await this.assertCoachOwnsWorkspace(coach, workspaceId);
    // Reuse the wearables subsystem's own coach-owns-client gate (the single
    // source of truth for the coaching relationship) — never re-implement it.
    await this.insights.assertCoachOwnsClient(coach.id, clientId, coach.role);
  }

  private toView(p: PromptWithSources): PromptView {
    return {
      id: p.id,
      workspaceId: p.workspaceId,
      coachId: p.coachId,
      clientId: p.clientId,
      metricKey: p.metricKey,
      promptText: p.promptText,
      sources: p.sources.map((s) => ({
        sampleId: s.sampleId,
        metricKey: s.metricKey,
        // Round to the column's stored precision (DECIMAL(18,6)) so the wire
        // value is deterministic and never leaks float-binary imprecision
        // (e.g. 72.000000001) into the coach-facing view (PR #399 F6).
        observedValue: Number(
          (s.observedValue instanceof Prisma.Decimal
            ? s.observedValue.toNumber()
            : Number(s.observedValue)
          ).toFixed(6),
        ),
      })),
      generatedAt: p.generatedAt.toISOString(),
      dismissedAt: p.dismissedAt ? p.dismissedAt.toISOString() : null,
      actedOnAt: p.actedOnAt ? p.actedOnAt.toISOString() : null,
    };
  }
}
