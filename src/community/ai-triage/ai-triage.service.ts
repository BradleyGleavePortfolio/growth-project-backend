import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { User } from '@prisma/client';
import { AiGatewayService } from '../../ai/gateway/ai-gateway.service';
import {
  CommunityCoachInboxRepository,
  MessageWithSender,
  PostWithAuthor,
} from '../inbox/community-coach-inbox.repository';
import { CommunityAccessService } from '../community-access.service';
import { TriageCacheService } from './triage-cache.service';
import buildInboxTriagePrompt, {
  PROMPT_VERSION as INBOX_TRIAGE_VERSION,
  TriagePromptItem,
} from './prompts/inbox-triage.prompt';
import {
  TRIAGE_CATEGORIES,
  TriageBucket,
  TriageItem,
  TriageModelOutputSchema,
  TriageResponse,
  TriageResponseSchema,
  emptyBuckets,
  emptyTriage,
} from './triage-output.schema';

// v2-4 — community AI inbox-triage generation.
//
// Reuses, never edits, the existing seams:
//   - AiGatewayService.invoke() — the single LLM seam (provider resolution,
//     fail-closed stub, redaction, AiRequestAudit row, CoachAIBudget metering).
//     This is a READ/CLASSIFY-only capability; it never maps to a draft.*
//     capability, so there is no materialiser and NO write/send path. The
//     "no autonomous send" invariant is structural: this service has no
//     dependency that can post a message.
//   - CommunityCoachInboxRepository — the v1-6 tenant-scoped candidate source.
//     coachedCohortIds() bounds every read to cohorts the requesting coach
//     actually coaches, so another workspace's messages can never enter the
//     prompt context (tenant-isolation invariant).
//   - TriageCacheService — in-process cache with freshness invalidation
//     (R69: no new Prisma table).
//
// On top we add: candidate fetch + sanitise, prompt build, strict Zod parse
// (single repair retry), tone guardrail, source-id reconciliation (the model
// may only cite ids we passed in), and graceful degradation to a typed empty
// triage on any failure (never a fabricated "all clear").

// Capability handed to the gateway — distinct so an operator can meter it
// independently. Registered in COACH_AI_METERED_CAPABILITIES.
export const COMMUNITY_AI_TRIAGE_CAPABILITY = 'community_ai_triage';

// Wall-clock budget for the LLM round-trip (graceful degradation on timeout).
export const TRIAGE_LLM_TIMEOUT_MS = 30_000;

// How many unanswered items we pull per stream before merging. Bounds prompt
// size + LLM cost; the inbox itself paginates, so this is a triage window, not
// the whole history.
const TRIAGE_CANDIDATE_LIMIT = 50;

const NOT_COACH = {
  error: 'forbidden',
  code: 'community.ai_triage.not_coach',
} as const;

// Alarmist tokens we refuse to ship in a summary, regardless of category. The
// triage copy must stay professional; a model that produces panicky or medical
// phrasing trips this and the item is dropped to a safe neutral summary rather
// than surfaced verbatim.
const ALARMIST_PATTERNS: readonly RegExp[] = [
  /\bemergency\b/i,
  /\burgent(?:ly)?!+/i,
  /\b911\b/i,
  /\bhospital\b/i,
  /\bdiagnos(?:e|is|ed)\b/i,
  /\bmedical\b/i,
  /\bdying\b/i,
  /\bdanger(?:ous)?\b/i,
];

interface Candidate {
  id: string;
  kind: 'message' | 'post';
  preview: string;
  cohortName: string;
  authorDisplayName: string;
  createdAt: Date;
}

@Injectable()
export class AiTriageService {
  private readonly logger = new Logger(AiTriageService.name);
  private lastModelUsed = 'stub';

  constructor(
    private readonly gateway: AiGatewayService,
    private readonly repo: CommunityCoachInboxRepository,
    private readonly access: CommunityAccessService,
    private readonly cache: TriageCacheService,
  ) {}

  /**
   * Generate (or serve cached) triage for the requesting coach's unanswered
   * community inbox. Authorization: the caller must coach at least one cohort
   * (coachedCohortIds non-empty) — otherwise 403 not_coach, mirroring the v1-6
   * inbox. Every candidate is bounded to those coached cohorts.
   */
  async generateForCoach(user: User): Promise<TriageResponse> {
    const cohortIds = await this.repo.coachedCohortIds(user.id);
    if (cohortIds.length === 0) {
      throw new ForbiddenException(NOT_COACH);
    }

    const candidates = await this.fetchCandidates(cohortIds);
    const freshnessKey = TriageCacheService.freshnessKey({
      itemCount: candidates.length,
      newestCreatedAt: newestCreatedAt(candidates),
    });

    // Cache check — a fresh (non-expired, same-freshness) row short-circuits
    // the whole pipeline. A new unanswered message changes freshnessKey → miss.
    const cached = this.cache.get(user.id, freshnessKey);
    if (cached) {
      this.logger.debug(`triage cache HIT coach=${user.id}`);
      return cached;
    }

    // Nothing unanswered → typed empty triage (no LLM call, no fabrication).
    if (candidates.length === 0) {
      const empty = emptyTriage(new Date());
      this.cache.set(user.id, freshnessKey, empty);
      return empty;
    }

    const promptItems = candidates.map((c) => this.toPromptItem(c));
    const prompt = buildInboxTriagePrompt(promptItems);

    let raw: string;
    try {
      raw = await this.invokeWithTimeout(user, prompt.system, prompt.user);
    } catch (err) {
      this.logger.warn(
        `triage LLM failed/timed out coach=${user.id}: ${(err as Error).message}`,
      );
      return emptyTriage(new Date());
    }

    let parsed = this.tryParse(raw);
    if (!parsed) {
      const repairUser = this.repairPrompt(prompt.user, raw);
      let repaired: string;
      try {
        repaired = await this.invokeWithTimeout(user, prompt.system, repairUser);
      } catch (err) {
        this.logger.warn(
          `triage repair failed coach=${user.id}: ${(err as Error).message}`,
        );
        return emptyTriage(new Date());
      }
      parsed = this.tryParse(repaired);
      if (!parsed) {
        this.logger.warn(
          `triage output invalid after repair coach=${user.id} — failing empty`,
        );
        return emptyTriage(new Date());
      }
    }

    // Reconcile against the candidate set: only items the model classified by a
    // REAL id we passed in survive; an id the model invented is dropped. This
    // is the anti-fabrication boundary — provenance is always a candidate id.
    const allowed = new Map(candidates.map((c) => [c.id, c]));
    const response = this.project(parsed.buckets, allowed);

    this.cache.set(user.id, freshnessKey, response);
    this.logger.debug(
      `triage generated coach=${user.id} items=${response.source_item_ids.length} model=${this.lastModelUsed} prompt=${INBOX_TRIAGE_VERSION}`,
    );
    return response;
  }

  /**
   * Project the model buckets into the locked wire response. Drops any item
   * whose id is not in the candidate set, coerces source_kind to the candidate's
   * real kind, and runs the tone guardrail over each summary. Buckets are
   * rebuilt in the canonical category order so the wire shape is deterministic.
   */
  private project(
    modelBuckets: TriageBucket[],
    allowed: Map<string, Candidate>,
  ): TriageResponse {
    const byCategory = new Map(emptyBuckets().map((b) => [b.category, b]));
    const seen = new Set<string>();
    const sourceIds: string[] = [];

    for (const bucket of modelBuckets) {
      for (const item of bucket.items) {
        const candidate = allowed.get(item.source_item_id);
        if (!candidate) continue; // fabricated / stale id — drop
        if (seen.has(item.source_item_id)) continue; // classified twice — keep first
        const target = byCategory.get(item.category);
        if (!target) continue;
        const safe: TriageItem = {
          source_item_id: item.source_item_id,
          source_kind: candidate.kind,
          category: item.category,
          summary: this.safeSummary(item.summary, candidate),
        };
        target.items.push(safe);
        seen.add(item.source_item_id);
        sourceIds.push(item.source_item_id);
      }
    }

    const buckets = TRIAGE_CATEGORIES.map(
      (category) => byCategory.get(category) as TriageBucket,
    );

    return TriageResponseSchema.parse({
      generated_at: new Date().toISOString(),
      is_empty: sourceIds.length === 0,
      buckets,
      source_item_ids: sourceIds,
    });
  }

  /**
   * Tone guardrail: if a summary trips an alarmist/medical pattern, fall back
   * to a neutral provenance-only summary derived from the candidate kind +
   * cohort. We never ship the flagged copy.
   */
  private safeSummary(summary: string, candidate: Candidate): string {
    const collapsed = summary.replace(/\s+/g, ' ').trim();
    const tripped = ALARMIST_PATTERNS.some((re) => re.test(collapsed));
    if (collapsed.length === 0 || tripped) {
      const noun = candidate.kind === 'post' ? 'post' : 'message';
      return `Unanswered ${noun} in ${candidate.cohortName} from ${candidate.authorDisplayName}.`.slice(
        0,
        280,
      );
    }
    return collapsed.slice(0, 280);
  }

  private toPromptItem(c: Candidate): TriagePromptItem {
    const ageMs = Date.now() - c.createdAt.getTime();
    return {
      id: c.id,
      kind: c.kind,
      preview: c.preview,
      cohortName: c.cohortName,
      authorDisplayName: c.authorDisplayName,
      ageHours: Math.max(0, Math.round(ageMs / (60 * 60 * 1000))),
    };
  }

  /**
   * Fetch unanswered messages + posts across the coached cohorts and shape them
   * into sanitised candidates. Tenant boundary: cohortIds came from
   * coachedCohortIds(user.id), so this can only ever read the caller's own
   * coached cohorts.
   */
  private async fetchCandidates(cohortIds: string[]): Promise<Candidate[]> {
    const [messages, posts] = await Promise.all([
      this.repo.unansweredMessages({
        cohortIds,
        limit: TRIAGE_CANDIDATE_LIMIT,
        after: null,
      }),
      this.repo.unansweredPosts({
        cohortIds,
        limit: TRIAGE_CANDIDATE_LIMIT,
        after: null,
      }),
    ]);

    const cohortNames = await this.resolveCohortNames([
      ...messages.map((m) => m.cohort_id as string),
      ...posts.map((p) => p.cohort_id as string),
    ]);

    const fromMessages = messages.map((m) =>
      this.messageCandidate(m, cohortNames.get(m.cohort_id as string) ?? ''),
    );
    const fromPosts = posts.map((p) =>
      this.postCandidate(p, cohortNames.get(p.cohort_id as string) ?? ''),
    );

    return [...fromMessages, ...fromPosts].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }

  private messageCandidate(m: MessageWithSender, cohortName: string): Candidate {
    return {
      id: m.id,
      kind: 'message',
      preview: preview(m.body),
      cohortName,
      authorDisplayName: m.sender.name,
      createdAt: m.created_at,
    };
  }

  private postCandidate(p: PostWithAuthor, cohortName: string): Candidate {
    return {
      id: p.id,
      kind: 'post',
      preview: preview(p.body ?? p.title ?? ''),
      cohortName,
      authorDisplayName: p.author.name,
      createdAt: p.created_at,
    };
  }

  private async resolveCohortNames(
    cohortIds: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(cohortIds)];
    const map = new Map<string, string>();
    await Promise.all(
      unique.map(async (id) => {
        const cohort = await this.access.findCohort(id);
        if (cohort) map.set(id, cohort.name);
      }),
    );
    return map;
  }

  private async invokeWithTimeout(
    user: User,
    systemPrompt: string,
    userMessage: string,
  ): Promise<string> {
    const invocation = this.gateway.invoke({
      capability: COMMUNITY_AI_TRIAGE_CAPABILITY,
      requester: { id: user.id, role: user.role },
      tenantCoachId: user.id,
      userMessage,
      systemPrompt,
      maxTokens: 1200,
      temperature: 0.2,
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`triage LLM timeout after ${TRIAGE_LLM_TIMEOUT_MS}ms`)),
        TRIAGE_LLM_TIMEOUT_MS,
      );
      if (typeof timer.unref === 'function') timer.unref();
    });

    try {
      const result = await Promise.race([invocation, timeout]);
      this.lastModelUsed = result.model || result.provider || 'stub';
      return result.reply;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private tryParse(raw: string): { buckets: TriageBucket[] } | null {
    const json = extractJsonObject(raw);
    if (json == null) return null;
    let obj: unknown;
    try {
      obj = JSON.parse(json);
    } catch {
      return null;
    }
    const result = TriageModelOutputSchema.safeParse(obj);
    return result.success ? result.data : null;
  }

  private repairPrompt(originalUser: string, badOutput: string): string {
    return `${originalUser}

You returned invalid JSON that did not match the required schema. Here is what you returned:
${badOutput.slice(0, 1500)}

Return ONLY a single valid JSON object matching the schema exactly. No prose, no markdown fences.`;
  }
}

const PREVIEW_MAX = 240;

function preview(body: string | null): string {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) : text;
}

function newestCreatedAt(candidates: Candidate[]): Date | null {
  let newest: Date | null = null;
  for (const c of candidates) {
    if (!newest || c.createdAt.getTime() > newest.getTime()) newest = c.createdAt;
  }
  return newest;
}

// Pull the first balanced {...} JSON object out of a string (models sometimes
// wrap JSON in prose despite instructions). Mirrors the wearable-insights
// extractor — a single proven helper shape, not a re-invented parser.
function extractJsonObject(text: string): string | null {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
