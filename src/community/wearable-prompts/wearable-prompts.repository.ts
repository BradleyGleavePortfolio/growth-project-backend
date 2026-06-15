import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  WearableMetricType,
  type CommunityWearablePrompt,
  type CommunityWearablePromptSource,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { WEARABLE_PROMPT_COOLDOWN_MS } from './wearable-prompts.dto';

const NOT_FOUND = {
  error: 'not_found',
  code: 'community.wearable_prompts.not_found',
} as const;

export interface PromptSourceSeed {
  sampleId: string;
  metricKey: string;
  observedValue: number;
}

export type PromptWithSources = CommunityWearablePrompt & {
  sources: CommunityWearablePromptSource[];
};

/**
 * v3-4 wearable-prompts repository — the only place that writes the
 * community_wearable_prompts + community_wearable_prompt_sources tables and
 * reads WearableSample ids for the source-audit trail (read-only consumption
 * of the wearables subsystem; never a write to it).
 */
@Injectable()
export class WearablePromptsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Real WearableSample.id list (newest first) for a (client, metric) within
   * the lookback window, capped. These ids become the prompt's source-audit
   * rows so every prompt provably references a REAL sample (brief test 4).
   */
  async findRecentSampleIds(
    clientId: string,
    metric: WearableMetricType,
    since: Date,
    limit = 20,
  ): Promise<Array<{ id: string; value: number }>> {
    const rows = await this.prisma.wearableSample.findMany({
      where: { user_id: clientId, metric, start_at: { gte: since } },
      orderBy: { start_at: 'desc' },
      take: limit,
      select: { id: true, value: true },
    });
    return rows;
  }

  /**
   * True when a prompt for (coachId, clientId, metricKey) is still within the
   * 24h cooldown (TWO-GATE design, PR #399 audit F4 / Decision 9 (A)):
   *
   *   Gate 1 (concurrent-undismissed): the partial unique index
   *     community_wearable_prompts_active_cooldown_key blocks a second *active*
   *     (non-dismissed) prompt for the same key — a concurrent insert raises
   *     P2002 → the service maps it to a 'cooldown' skip.
   *   Gate 2 (cooldown-across-dismissed): THIS query counts any prompt generated
   *     within the 24h window REGARDLESS of dismissedAt. Dismissing a prompt
   *     does NOT re-open the window before 24h has elapsed, because the
   *     `generatedAt >= since` predicate ignores the dismissed state — which the
   *     partial index alone cannot do (a dismissed row drops out of the index).
   */
  async isWithinCooldown(
    coachId: string,
    clientId: string,
    metricKey: string,
    now: Date,
  ): Promise<boolean> {
    const since = new Date(now.getTime() - WEARABLE_PROMPT_COOLDOWN_MS);
    const recent = await this.prisma.communityWearablePrompt.findFirst({
      where: {
        coachId,
        clientId,
        metricKey,
        // dismissedAt is intentionally NOT filtered: a prompt generated within
        // the window still gates a new one even after the coach dismissed it.
        generatedAt: { gte: since },
      },
      select: { id: true },
    });
    return recent !== null;
  }

  /**
   * Create a prompt + its source rows in ONE transaction (brief: multi-row
   * writes via $transaction). Returns the prompt with sources. A P2002 from
   * the cooldown unique index is surfaced to the caller to map to a skip.
   */
  async createPromptWithSources(input: {
    workspaceId: string;
    coachId: string;
    clientId: string;
    metricKey: string;
    promptText: string;
    sources: PromptSourceSeed[];
  }): Promise<PromptWithSources> {
    return this.prisma.$transaction(async (tx) => {
      const prompt = await tx.communityWearablePrompt.create({
        data: {
          workspaceId: input.workspaceId,
          coachId: input.coachId,
          clientId: input.clientId,
          metricKey: input.metricKey,
          promptText: input.promptText,
        },
      });
      await tx.communityWearablePromptSource.createMany({
        data: input.sources.map((s) => ({
          promptId: prompt.id,
          sampleId: s.sampleId,
          metricKey: s.metricKey,
          observedValue: new Prisma.Decimal(s.observedValue),
        })),
      });
      const sources = await tx.communityWearablePromptSource.findMany({
        where: { promptId: prompt.id },
      });
      return { ...prompt, sources };
    });
  }

  /** List a coach's prompts (coach-scoped), optionally for a single client. */
  async listForCoach(params: {
    workspaceId: string;
    coachId: string;
    clientId?: string;
    includeDismissed: boolean;
    limit: number;
  }): Promise<PromptWithSources[]> {
    return this.prisma.communityWearablePrompt.findMany({
      where: {
        workspaceId: params.workspaceId,
        coachId: params.coachId,
        ...(params.clientId ? { clientId: params.clientId } : {}),
        ...(params.includeDismissed ? {} : { dismissedAt: null }),
      },
      orderBy: { generatedAt: 'desc' },
      take: params.limit,
      include: { sources: true },
    });
  }

  /** Fetch one prompt scoped to the coach (coach-only read). */
  async findOneForCoach(
    promptId: string,
    coachId: string,
  ): Promise<PromptWithSources | null> {
    return this.prisma.communityWearablePrompt.findFirst({
      where: { id: promptId, coachId },
      include: { sources: true },
    });
  }

  /**
   * Atomically dismiss a prompt the coach owns, returning the fresh row with
   * sources. The race-guarded `updateMany` re-asserts `coachId` in the WHERE
   * (RLS-safe TOCTOU close, PR #398 F3 / PR #399 F5) so the authorizing read and
   * the write are a single coach-scoped operation — no window where coachId could
   * drift between a separate find and update. A zero-row result is disambiguated
   * with one coach-scoped read: a non-existent / foreign prompt → 404 (existence
   * never leaks, never a 403); an already-dismissed prompt → idempotent return of
   * the existing row with its original dismissedAt (no re-stamp).
   */
  async markDismissed(
    promptId: string,
    coachId: string,
    at: Date,
  ): Promise<PromptWithSources> {
    const res = await this.prisma.communityWearablePrompt.updateMany({
      where: { id: promptId, coachId, dismissedAt: null },
      data: { dismissedAt: at },
    });
    if (res.count === 0) {
      const existing = await this.findOneForCoach(promptId, coachId);
      if (!existing) throw new NotFoundException(NOT_FOUND);
      return existing; // already dismissed — idempotent
    }
    const fresh = await this.findOneForCoach(promptId, coachId);
    if (!fresh) throw new NotFoundException(NOT_FOUND);
    return fresh;
  }

  /**
   * Atomically act-on a prompt the coach owns, returning the fresh row with
   * sources. Same RLS-safe coachId re-assert + 404-not-403 + idempotent
   * semantics as markDismissed.
   */
  async markActedOn(
    promptId: string,
    coachId: string,
    at: Date,
  ): Promise<PromptWithSources> {
    const res = await this.prisma.communityWearablePrompt.updateMany({
      where: { id: promptId, coachId, actedOnAt: null },
      data: { actedOnAt: at },
    });
    if (res.count === 0) {
      const existing = await this.findOneForCoach(promptId, coachId);
      if (!existing) throw new NotFoundException(NOT_FOUND);
      return existing; // already acted-on — idempotent
    }
    const fresh = await this.findOneForCoach(promptId, coachId);
    if (!fresh) throw new NotFoundException(NOT_FOUND);
    return fresh;
  }
}
