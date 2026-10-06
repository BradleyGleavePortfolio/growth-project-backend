import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import type { User } from '@prisma/client';
import { AiGatewayService } from '../../ai/gateway/ai-gateway.service';
import {
  CommunityCoachInboxRepository,
  MessageWithSender,
  PostWithAuthor,
} from '../inbox/community-coach-inbox.repository';
import { CommunityAccessService } from '../community-access.service';
import { TriageCacheService } from './triage-cache.service';
import { AiEgressService } from '../../ai-egress/ai-egress.service';
import {
  AiConsentRequiredException,
  AiEgressPolicyException,
} from '../../ai-egress/ai-consent-required.exception';
import { AiTriageUnavailableException } from './ai-triage-unavailable.exception';
import buildInboxTriagePrompt, {
  PROMPT_VERSION as INBOX_TRIAGE_VERSION,
  TriagePromptItem,
} from './prompts/inbox-triage.prompt';
import {
  TRIAGE_CATEGORIES,
  TriageBucket,
  TriageCategory,
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

// Safety language a coach must never miss: self-harm, suicide, an eating
// disorder, or an acute physical symptom. Matched deterministically on the
// item's FULL text (not the 240-character preview), so such an item is ALWAYS
// counted under `urgent` ("Needs you soon") whatever the model returned, and
// is never dropped when the model skips it. Over-matching only moves an item
// up the coach's list; it never sends, replies or hides anything.
const SAFETY_PATTERNS: readonly RegExp[] = [
  /\bsuicid/i,
  /\bkill(?:ing)?\s+myself\b/i,
  /\bend(?:ing)?\s+(?:my\s+life|it\s+all)\b/i,
  /\b(?:want|wanna|going|ready)\s+(?:to\s+)?die\b/i,
  /\b(?:hurt|hurting|harm|harming|cut|cutting)\s+myself\b/i,
  /\bself[-\s]?harm/i,
  /\boverdos/i,
  /\bno\s+reason\s+to\s+live\b/i,
  /\bdon['\u2019]?t\s+want\s+to\s+(?:live|be\s+here)\b/i,
  /\b(?:purg(?:e|ed|ing)|starv(?:e|ed|ing)\s+myself|anorexi|bulimi|eating\s+disorder)/i,
  /\bchest\s+pains?\b/i,
  /\b(?:fainted|fainting|passed\s+out|blacked\s+out)\b/i,
];

/** True when the text carries safety language (see SAFETY_PATTERNS). */
export function needsSafetyAttention(text: string | null | undefined): boolean {
  const collapsed = (text ?? '').replace(/\s+/g, ' ');
  return SAFETY_PATTERNS.some((re) => re.test(collapsed));
}

interface Candidate {
  id: string;
  kind: 'message' | 'post';
  // Safety language in the full text: always `urgent`, never dropped.
  safety: boolean;
  // R2b — the client whose words these are; only authors with a live box-2
  // grant enter the prompt. Never sent to the provider.
  authorId: string;
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
    // R2b — box-2 consent filter for the authors in the prompt.
    private readonly egress: AiEgressService,
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
    return this.triageOnce(user, cohortIds, true);
  }

  /**
   * One triage pass. C-626-3 — if an author withdraws box 2 between the
   * consent filter and the send, the gateway refuses the whole prompt; the
   * pass is then re-run ONCE from a fresh candidate fetch and consent read,
   * so the remaining consenting authors still get triage instead of an
   * unexplained empty result.
   */
  private async triageOnce(
    user: User,
    cohortIds: string[],
    mayRefilter: boolean,
  ): Promise<TriageResponse> {
    const fetched = await this.fetchCandidates(cohortIds);
    // R2b — only items whose author holds a live box-2 grant reach the AI
    // (D2 box 2: "only your own data is used", processed by Anthropic). The
    // rest stay in the regular inbox, untriaged. The grant is read live here
    // and again by the gateway at send time.
    const consented = await this.egress.consentedClients(fetched.map((c) => c.authorId));
    const candidates = fetched.filter((c) => consented.has(c.authorId));
    // The cache key covers the exact consented item set, so a withdrawal
    // changes the key and a cached triage built from that author's words is
    // never served again.
    const freshnessKey = `${TriageCacheService.freshnessKey({
      itemCount: candidates.length,
      newestCreatedAt: newestCreatedAt(candidates),
    })}:${createHash('sha256')
      .update(
        candidates
          .map((c) => c.id)
          .sort()
          .join(','),
      )
      .digest('hex')
      .slice(0, 16)}`;
    const authorIds = [...new Set(candidates.map((c) => c.authorId))];

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
      raw = await this.invokeWithTimeout(user, prompt.system, prompt.user, authorIds);
    } catch (err) {
      if (mayRefilter && err instanceof AiConsentRequiredException) {
        this.logger.log(`triage consent changed before send coach=${user.id}; re-filtering once`);
        return this.triageOnce(user, cohortIds, false);
      }
      this.logger.warn(
        `triage LLM failed/timed out coach=${user.id}: ${(err as Error).message}`,
      );
      throw this.unavailable(err);
    }

    let parsed = this.tryParse(raw);
    if (!parsed) {
      const repairUser = this.repairPrompt(prompt.user, raw);
      let repaired: string;
      try {
        repaired = await this.invokeWithTimeout(user, prompt.system, repairUser, authorIds);
      } catch (err) {
        if (mayRefilter && err instanceof AiConsentRequiredException) {
          this.logger.log(`triage consent changed before repair coach=${user.id}; re-filtering once`);
          return this.triageOnce(user, cohortIds, false);
        }
        this.logger.warn(
          `triage repair failed coach=${user.id}: ${(err as Error).message}`,
        );
        throw this.unavailable(err);
      }
      parsed = this.tryParse(repaired);
      if (!parsed) {
        this.logger.warn(
          `triage output invalid after repair coach=${user.id} — triage unavailable`,
        );
        throw new AiTriageUnavailableException();
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
   * C-626-4 — an AI failure is an explicit 503 `ai_triage_unavailable`, never
   * an empty triage the coach would read as "nothing needs attention". An
   * egress policy refusal keeps its own code (503 `ai_egress_blocked`, a
   * server defect with a support path). Failures are never cached.
   */
  private unavailable(err: unknown): AiEgressPolicyException | AiTriageUnavailableException {
    return err instanceof AiEgressPolicyException ? err : new AiTriageUnavailableException();
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

    const place = (candidate: Candidate, category: TriageCategory, summary: string): void => {
      // Safety language always lands in `urgent` with the neutral summary,
      // whatever the model said (or if it said nothing about the item).
      const finalCategory: TriageCategory = candidate.safety ? 'urgent' : category;
      const target = byCategory.get(finalCategory);
      if (!target) return;
      target.items.push({
        source_item_id: candidate.id,
        source_kind: candidate.kind,
        category: finalCategory,
        summary: this.safeSummary(candidate.safety ? '' : summary, candidate),
      });
      seen.add(candidate.id);
      sourceIds.push(candidate.id);
    };

    for (const bucket of modelBuckets) {
      for (const item of bucket.items) {
        const candidate = allowed.get(item.source_item_id);
        if (!candidate) continue; // fabricated / stale id — drop
        if (seen.has(item.source_item_id)) continue; // classified twice — keep first
        place(candidate, item.category, item.summary);
      }
    }

    // An item the model skipped (a refusal, a prompt injection in another
    // member's text, or a plain miss) never vanishes from the triage: a safety
    // item goes to `urgent`, anything else to `general`, so the coach's count
    // matches the items that were sent for sorting.
    for (const candidate of allowed.values()) {
      if (!seen.has(candidate.id)) place(candidate, 'general', '');
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
      safety: needsSafetyAttention(m.body),
      authorId: m.sender.id,
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
      safety: needsSafetyAttention(`${p.title ?? ''} ${p.body ?? ''}`),
      authorId: p.author.id,
      preview: preview(p.body ?? p.title ?? ''),
      cohortName,
      authorDisplayName: p.author.name,
      createdAt: p.created_at,
    };
  }

  /**
   * Resolve cohort ids to names in a SINGLE query (was an N+1 of per-cohort
   * findCohort() calls — a cache miss can carry up to ~100 unique cohort ids
   * across the message + post candidate windows). Dedupe here, then issue one
   * batched findMany via the access service.
   */
  private async resolveCohortNames(
    cohortIds: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(cohortIds)];
    const map = new Map<string, string>();
    if (unique.length === 0) return map;
    const cohorts = await this.access.findCohortsByIds(unique);
    for (const cohort of cohorts) {
      map.set(cohort.id, cohort.name);
    }
    return map;
  }

  private async invokeWithTimeout(
    user: User,
    systemPrompt: string,
    userMessage: string,
    authorIds: readonly string[],
  ): Promise<string> {
    const invocation = this.gateway.invoke({
      capability: COMMUNITY_AI_TRIAGE_CAPABILITY,
      requester: { id: user.id, role: user.role },
      tenantCoachId: user.id,
      // R2b — every author in the prompt (cohort-scoped above).
      dataClientIds: authorIds,
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
