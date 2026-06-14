import { Injectable } from '@nestjs/common';
import {
  Prisma,
  WearableMetricType,
  type CommunityWearablePrompt,
  type CommunityWearablePromptSource,
} from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { WEARABLE_PROMPT_COOLDOWN_MS } from './wearable-prompts.dto';

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
   * True when a prompt for (coachId, clientId, metricKey) was generated within
   * the cooldown window. Belt to the partial-unique-index braces: the index is
   * the authoritative race guard (a concurrent insert raises P2002), this is
   * the cheap pre-check for the skip path.
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

  async markDismissed(promptId: string, at: Date): Promise<void> {
    await this.prisma.communityWearablePrompt.update({
      where: { id: promptId },
      data: { dismissedAt: at },
    });
  }

  async markActedOn(promptId: string, at: Date): Promise<void> {
    await this.prisma.communityWearablePrompt.update({
      where: { id: promptId },
      data: { actedOnAt: at },
    });
  }
}
