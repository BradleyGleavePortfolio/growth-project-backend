import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { WearableMetricBucket } from '@prisma/client';
import { ZodSchema } from 'zod';
import { PrismaService } from '../../prisma.service';
import { AiGatewayService } from '../../ai/gateway/ai-gateway.service';
import { InsightCacheService, INSIGHT_WINDOW_DAYS } from './insight-cache.service';
import {
  CoachInsight,
  ClientInsight,
  CoachInsightSchema,
  ClientInsightSchema,
  CoachInsightResponse,
  ClientInsightResponse,
  EmptyInsight,
  InsightAudience,
  InsightSample,
  InsightUserContext,
  BuildPromptInput,
  BuildPromptResult,
  emptyInsight,
} from './insight-output.schema';
import { applyGuardrails, calibrateConfidence } from './guardrails';
import buildCoachHfPrompt, {
  PROMPT_VERSION as COACH_HF_VERSION,
} from './prompts/coach-hf.prompt';
import buildCoachSrPrompt, {
  PROMPT_VERSION as COACH_SR_VERSION,
} from './prompts/coach-sr.prompt';
import buildClientHfPrompt, {
  PROMPT_VERSION as CLIENT_HF_VERSION,
} from './prompts/client-hf.prompt';
import buildClientSrPrompt, {
  PROMPT_VERSION as CLIENT_SR_VERSION,
} from './prompts/client-sr.prompt';

// PR-HK-4 — embedded AI insight generation (backend, no UI).
//
// Reuses, never edits, the existing AI surfaces:
//   - src/ai/gateway/AiGatewayService.invoke() — the single LLM seam. It
//     handles provider resolution (fail-closed to a deterministic stub),
//     redaction of free-text, the AiRequestAudit row (audit criteria #34),
//     and the CoachAIBudget rate-limit + cost-cap (#6). We pass a
//     wearable-specific capability string; the gateway fails closed to the
//     stub unless an operator allow-lists it, so this PR is safe-by-default.
//   - WearableInsightCache (PR-HK-0) — read/write via InsightCacheService.
//
// On top of the gateway we add the wearable-specific concerns the gateway
// does not own: bucket+audience prompt selection, strict Zod validation of
// the model's JSON, a single repair retry, no-medicalize guardrails, a 30s
// timeout with graceful degradation to cached/empty, and the dual-role
// schema projection (coach fields never reach a client).

// Capability strings handed to the gateway. Distinct per audience so an
// operator can allow-list / meter them independently.
export const COACH_INSIGHT_CAPABILITY = 'wearable_insight.coach';
export const CLIENT_INSIGHT_CAPABILITY = 'wearable_insight.client';

// 30s wall-clock budget for the LLM round-trip (audit criteria #35/#50).
export const LLM_TIMEOUT_MS = 30_000;

// Trailing window for the trend digest.
const TREND_WINDOW_DAYS = INSIGHT_WINDOW_DAYS;

type PromptBuilderFn = (input: BuildPromptInput) => BuildPromptResult;

@Injectable()
export class WearableInsightsService {
  private readonly logger = new Logger(WearableInsightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
    private readonly cache: InsightCacheService,
  ) {}

  // Authorization: assert the coach (or owner) currently owns the
  // coaching relationship to the client. Mirrors CoachService
  // .assertCoachOwnsClient (which is private there) without editing it —
  // IDOR defence for the coach insight endpoint (audit criteria #5).
  // Owners bypass (platform admins) consistent with CoachGuard.
  async assertCoachOwnsClient(
    coachId: string,
    clientId: string,
    requesterRole: string,
  ): Promise<void> {
    if (requesterRole === 'owner') return;
    const client = await this.prisma.user.findFirst({
      where: {
        id: clientId,
        coach_id: coachId,
        role: 'student',
        deleted_at: null,
      },
      select: { id: true },
    });
    if (!client) {
      throw new ForbiddenException('Client is not assigned to this coach');
    }
  }

  // ── Public API ─────────────────────────────────────────────────────
  async generateForCoach(
    coachId: string,
    clientId: string,
    bucket: WearableMetricBucket,
  ): Promise<CoachInsightResponse> {
    return this.generate<CoachInsight>({
      audience: 'coach',
      subjectUserId: clientId,
      requesterId: coachId,
      requesterRole: 'coach',
      tenantCoachId: coachId,
      bucket,
      schema: CoachInsightSchema,
      capability: COACH_INSIGHT_CAPABILITY,
      builder: bucket === WearableMetricBucket.HEALTH_FITNESS ? buildCoachHfPrompt : buildCoachSrPrompt,
      promptVersion:
        bucket === WearableMetricBucket.HEALTH_FITNESS ? COACH_HF_VERSION : COACH_SR_VERSION,
    });
  }

  async generateForClient(
    userId: string,
    bucket: WearableMetricBucket,
  ): Promise<ClientInsightResponse> {
    return this.generate<ClientInsight>({
      audience: 'client',
      subjectUserId: userId,
      requesterId: userId,
      requesterRole: 'student',
      tenantCoachId: undefined,
      bucket,
      schema: ClientInsightSchema,
      capability: CLIENT_INSIGHT_CAPABILITY,
      builder:
        bucket === WearableMetricBucket.HEALTH_FITNESS ? buildClientHfPrompt : buildClientSrPrompt,
      promptVersion:
        bucket === WearableMetricBucket.HEALTH_FITNESS ? CLIENT_HF_VERSION : CLIENT_SR_VERSION,
    });
  }

  // ── Core flow ───────────────────────────────────────────────────────
  private async generate<T extends CoachInsight | ClientInsight>(opts: {
    audience: InsightAudience;
    subjectUserId: string;
    requesterId: string;
    requesterRole: string;
    tenantCoachId?: string;
    bucket: WearableMetricBucket;
    schema: ZodSchema<T>;
    capability: string;
    builder: PromptBuilderFn;
    promptVersion: string;
  }): Promise<T | EmptyInsight> {
    const { audience, subjectUserId, bucket } = opts;

    // 1. Cache check — a fresh (non-expired, non-invalidated) row short-
    //    circuits the whole pipeline. No LLM call, no audit row.
    const cached = (await this.cache.get(audience, subjectUserId, bucket)) as T | null;
    if (cached) {
      this.logger.debug(
        `insight cache HIT audience=${audience} user=${subjectUserId} bucket=${bucket}`,
      );
      return cached;
    }

    // 2. Fetch the last-14d samples for the bucket (the prompt layer never
    //    touches the DB; we own retrieval so the tenant boundary is here).
    const samples = await this.fetchSamples(subjectUserId, bucket);
    const userContext = await this.buildUserContext(subjectUserId, opts.tenantCoachId);

    // 3. Build the bucket+audience prompt.
    const prompt = opts.builder({ samples, userContext, bucket });

    // 4. Call the LLM via the gateway, under a 30s timeout. On timeout we
    //    degrade gracefully to the last cached row (even if stale), else
    //    an explicit empty insight.
    let raw: string;
    try {
      raw = await this.invokeWithTimeout(opts, prompt, prompt.user);
    } catch (err) {
      this.logger.warn(
        `insight LLM call failed/timed out audience=${audience} user=${subjectUserId}: ${(err as Error).message}`,
      );
      const stale = (await this.cache.getEvenIfStale(audience, subjectUserId, bucket)) as T | null;
      if (stale) return stale;
      return emptyInsight();
    }

    // 5. Validate the model JSON against the audience schema. On failure,
    //    retry ONCE with a repair prompt, then fail explicit (empty).
    let parsed = this.tryParse(opts.schema, raw);
    if (!parsed) {
      const repairUser = this.repairPrompt(prompt.user, raw);
      let repaired: string;
      try {
        repaired = await this.invokeWithTimeout(opts, prompt, repairUser);
      } catch (err) {
        this.logger.warn(
          `insight repair call failed audience=${audience}: ${(err as Error).message}`,
        );
        const stale = (await this.cache.getEvenIfStale(audience, subjectUserId, bucket)) as T | null;
        return stale ?? emptyInsight();
      }
      parsed = this.tryParse(opts.schema, repaired);
      if (!parsed) {
        this.logger.warn(
          `insight output invalid after repair audience=${audience} user=${subjectUserId} — failing explicit`,
        );
        const stale = (await this.cache.getEvenIfStale(audience, subjectUserId, bucket)) as T | null;
        return stale ?? emptyInsight();
      }
    }

    // 6. Guardrails — reject medicalizing language across every text field.
    //    A rejection means the model produced unsafe copy; we do NOT ship
    //    it. We fall back to a stale cache if present, else an empty
    //    insight (never the rejected text).
    const guarded = this.enforceGuardrails(parsed);
    if (guarded.rejected) {
      this.logger.warn(
        `insight guardrail REJECT audience=${audience} user=${subjectUserId} reason=${guarded.reason}`,
      );
      const stale = (await this.cache.getEvenIfStale(audience, subjectUserId, bucket)) as T | null;
      return stale ?? emptyInsight();
    }
    const safe = guarded.value as T;

    // 7. Persist to cache (model_used + prompt_version recorded for audit).
    //    The gateway already wrote the AiRequestAudit row inside invoke().
    try {
      await this.cache.set(audience, subjectUserId, bucket, safe, {
        modelUsed: this.lastModelUsed,
        promptVersion: opts.promptVersion,
      });
    } catch (err) {
      // A cache write failure must not fail the request — the insight is
      // already computed and safe to return.
      this.logger.error(
        `insight cache write failed audience=${audience} user=${subjectUserId}: ${(err as Error).message}`,
      );
    }

    return safe;
  }

  // Tracks the model id reported by the most recent gateway call so set()
  // can record it. Set inside invokeWithTimeout. Defaults to 'stub'.
  private lastModelUsed = 'stub';

  // Invoke the gateway under a hard timeout. The gateway itself fails
  // closed to a stub on provider error; the timeout guards against a
  // hung upstream (audit criteria #35).
  private async invokeWithTimeout(
    opts: {
      audience: InsightAudience;
      subjectUserId: string;
      requesterId: string;
      requesterRole: string;
      tenantCoachId?: string;
      capability: string;
    },
    prompt: BuildPromptResult,
    userMessage: string,
  ): Promise<string> {
    const invocation = this.gateway.invoke({
      capability: opts.capability,
      requester: { id: opts.requesterId, role: opts.requesterRole },
      subjectUserId: opts.subjectUserId,
      tenantCoachId: opts.tenantCoachId,
      userMessage,
      systemPrompt: prompt.system,
      maxTokens: 700,
      temperature: 0.4,
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`insight LLM timeout after ${LLM_TIMEOUT_MS}ms`)),
        LLM_TIMEOUT_MS,
      );
      // Do not let a pending timeout keep the process / test runner alive
      // once the race has already settled on the invocation.
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

  // Strict parse: extract the first JSON object from the model text (models
  // sometimes wrap JSON in prose despite instructions), then Zod-validate.
  // Returns null on any failure so the caller can retry/fallback.
  private tryParse<T>(schema: ZodSchema<T>, raw: string): T | null {
    const json = extractJsonObject(raw);
    if (json == null) return null;
    let obj: unknown;
    try {
      obj = JSON.parse(json);
    } catch {
      return null;
    }
    const result = schema.safeParse(obj);
    return result.success ? result.data : null;
  }

  private repairPrompt(originalUser: string, badOutput: string): string {
    return `${originalUser}

You returned invalid JSON that did not match the required schema. Here is what you returned:
${badOutput.slice(0, 1500)}

Return ONLY a single valid JSON object matching the schema exactly. No prose, no markdown fences.`;
  }

  // Run every text field through the no-medicalize guardrail. If any field
  // trips a block rule the whole insight is rejected. Confidence is also
  // re-calibrated defensively from the label back through the calibration
  // table is not possible (we only have the label), so we leave the
  // validated label as-is; calibrateConfidence is exercised by the
  // norm-comparison enrichment + tests as the canonical mapping.
  private enforceGuardrails<T extends CoachInsight | ClientInsight>(
    insight: T,
  ): { rejected: boolean; reason?: string; value?: T } {
    const fields = collectTextFields(insight);
    for (const f of fields) {
      const res = applyGuardrails(f);
      if (res.rejected) {
        return { rejected: true, reason: res.reason };
      }
    }
    return { rejected: false, value: insight };
  }

  // Fetch the last-14d samples for a (user, bucket), shaped for the prompt
  // builders. Ordered ascending so "latest" is the last element.
  private async fetchSamples(
    userId: string,
    bucket: WearableMetricBucket,
  ): Promise<InsightSample[]> {
    const since = new Date(Date.now() - TREND_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.wearableSample.findMany({
      where: { user_id: userId, bucket, start_at: { gte: since } },
      orderBy: { start_at: 'asc' },
      select: {
        metric: true,
        value: true,
        unit: true,
        start_at: true,
        end_at: true,
      },
    });
    return rows.map((r) => ({
      metric: r.metric,
      value: r.value,
      unit: r.unit,
      start_at: r.start_at,
      end_at: r.end_at,
    }));
  }

  // Build the small user-context object the prompts personalise with.
  private async buildUserContext(
    subjectUserId: string,
    tenantCoachId?: string,
  ): Promise<InsightUserContext> {
    const subject = await this.prisma.user
      .findUnique({
        where: { id: subjectUserId },
        select: { name: true, profile: { select: { date_of_birth: true } } },
      })
      .catch(() => null);

    let coachFirstName: string | undefined;
    if (tenantCoachId) {
      const coach = await this.prisma.user
        .findUnique({ where: { id: tenantCoachId }, select: { name: true } })
        .catch(() => null);
      coachFirstName = firstNameOf(coach?.name ?? null);
    }

    return {
      firstName: firstNameOf(subject?.name ?? null),
      age: ageFromDob(subject?.profile?.date_of_birth ?? null),
      coachFirstName,
    };
  }
}

// ── Module-private helpers ──────────────────────────────────────────────

// Pull the first balanced {...} JSON object out of a string. Returns null
// if none is found. Handles models that prepend prose or wrap in ``` fences.
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

// All free-text string fields of either insight payload, for guardrail
// scanning. Numeric/enum/array fields are skipped.
function collectTextFields(insight: CoachInsight | ClientInsight): string[] {
  const out: string[] = [insight.observation];
  if ('hypothesis' in insight) {
    out.push(insight.hypothesis, insight.suggested_action, insight.suggested_message_draft);
  }
  if ('norm_comparison' in insight) {
    out.push(insight.norm_comparison, insight.intervention);
    if (insight.optional_cta) out.push(insight.optional_cta.label);
  }
  return out;
}

// First token of a display name, or undefined when absent.
function firstNameOf(name: string | null): string | undefined {
  if (!name) return undefined;
  const first = name.trim().split(/\s+/)[0];
  return first.length > 0 ? first : undefined;
}

// Whole-year age from a date_of_birth, or undefined when absent. Used to
// age-adjust the norm comparison enrichment.
function ageFromDob(dob: Date | null): number | undefined {
  if (!dob) return undefined;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age >= 0 && age < 130 ? age : undefined;
}

// Re-export so call sites / tests can reference the calibration mapping
// through the service module surface as well as guardrails.
export { calibrateConfidence };
