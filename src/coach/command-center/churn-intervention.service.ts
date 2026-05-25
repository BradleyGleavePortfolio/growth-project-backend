// src/coach/command-center/churn-intervention.service.ts
//
// ChurnInterventionService — backs the tap→draft→approve→send flow for
// at-risk clients. Surfaces a Claude-drafted re-engagement message,
// allows the coach to edit, and (on approve/send) writes a CoachNudge
// row + fires a push notification.
//
// R39 cross-cutting compliance:
//   * Idempotency  — both draft and send accept a mobile-generated UUID
//                    in the request body. Draft dedup via unique index
//                    on ChurnIntervention.idempotency_key. Send dedup
//                    via conditional `updateMany WHERE status NOT IN
//                    ('sent','dismissed')` (R39 item 7 — no check-then-
//                    act outside a transaction).
//   * Timeouts     — Anthropic call wrapped in AbortController, 10s
//                    timeout (R39 item 5).
//   * Sanitization — AI errors NEVER leak the prompt content or raw
//                    Anthropic error body to the client; we throw a
//                    structured 503 with a generic message.
//   * Race-safe    — send uses a single atomic updateMany; result.count
//                    determines whether the caller is the winning sender
//                    or a duplicate.

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../../prisma.service';
import { PtmService } from '../../ptm/ptm.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { COACH_AI_MODEL } from '../../ai/coach/coach-ai.constants';

// DI token so tests can inject a fake Anthropic client without reaching
// out to the public API. Production boot leaves it unset and the service
// lazily constructs a real client from ANTHROPIC_API_KEY.
export const CHURN_ANTHROPIC_CLIENT_TOKEN = 'CHURN_ANTHROPIC_CLIENT';

const ANTHROPIC_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_CHARS = 1000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Response shapes ────────────────────────────────────────────────────

export interface ChurnInterventionDto {
  intervention_id: string;
  client_id: string;
  client_name: string;
  draft_text: string;
  status: 'draft_pending' | 'draft' | 'draft_failed' | 'edited' | 'sent' | 'dismissed';
  top_factor: string;
  created_at: string;
}

export interface SendInterventionResponse {
  ok: true;
  intervention_id: string;
  sent_at: string;
  nudge_id: string;
}

export interface ChurnAtRiskEntry {
  user_id: string;
  display_name: string;
  bucket: 'red' | 'amber';
  risk_score: null;
  last_active_at: string | null;
  days_since_last_signal: number;
  risk_signals: Array<{
    key: string;
    label: string;
    severity: 'high' | 'medium' | 'protective';
  }>;
  top_factor: string;
  suggested_action:
    | 'send_checkin_message'
    | 'review_bloodwork'
    | 'none';
  score_computed_at: string;
}

export interface ChurnAtRiskResponse {
  items: ChurnAtRiskEntry[];
  generated_at: string;
}

interface PtmFactor {
  key: string;
  label: string;
  contribution: number;
}

function isPtmFactor(raw: unknown): raw is PtmFactor {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.key === 'string' &&
    typeof r.label === 'string' &&
    typeof r.contribution === 'number'
  );
}

function parseFactors(raw: Prisma.JsonValue | null | undefined): PtmFactor[] {
  if (!Array.isArray(raw)) return [];
  const factors: PtmFactor[] = [];
  for (const item of raw) {
    if (isPtmFactor(item)) factors.push(item);
  }
  return factors.sort((a, b) => b.contribution - a.contribution);
}

// Format a Date as YYYY-MM-DD in the given IANA timezone. Uses
// Intl.DateTimeFormat with an explicit `timeZone` so production hosts
// running with TZ=UTC (e.g. Fly.io) still bucket dates in the coach's
// local timezone. Never use toISOString().slice(0,10) — that returns
// the UTC date — and never use Date#getFullYear/getMonth/getDate, which
// silently fall back to the process timezone.
export function bucketDateLocal(d: Date, timeZone = 'America/Los_Angeles'): string {
  // en-CA produces ISO-style YYYY-MM-DD natively.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

@Injectable()
export class ChurnInterventionService {
  private readonly logger = new Logger(ChurnInterventionService.name);
  private anthropic: Anthropic | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ptm: PtmService,
    private readonly config: ConfigService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional()
    @Inject(CHURN_ANTHROPIC_CLIENT_TOKEN)
    injectedClient?: Anthropic,
  ) {
    if (injectedClient) this.anthropic = injectedClient;
  }

  private getAnthropicClient(): Anthropic {
    if (this.anthropic) return this.anthropic;
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey || !apiKey.trim()) {
      throw new InternalServerErrorException('ANTHROPIC_API_KEY not configured');
    }
    this.anthropic = new Anthropic({ apiKey });
    return this.anthropic;
  }

  // ── GET /churn-at-risk ────────────────────────────────────────────────
  async getChurnAtRisk(
    coachId: string,
    opts: { limit?: number; minBucket?: 'amber' | 'red' },
  ): Promise<ChurnAtRiskResponse> {
    const limit =
      opts.limit && Number.isFinite(opts.limit) && opts.limit > 0
        ? Math.min(Math.floor(opts.limit), 50)
        : 20;

    const rosterRows = await this.prisma.user.findMany({
      where: { coach_id: coachId, role: 'student', deleted_at: null },
      select: { id: true, name: true },
    });
    if (rosterRows.length === 0) {
      return { items: [], generated_at: new Date().toISOString() };
    }

    const rosterIds = rosterRows.map((r) => r.id);
    const nameMap = new Map(rosterRows.map((r) => [r.id, r.name]));

    // Latest PtmPrediction per client in this coach's roster.
    const groups = await this.prisma.ptmPrediction.groupBy({
      by: ['user_id'],
      _max: { computed_at: true },
      where: { user_id: { in: rosterIds } },
    });
    if (groups.length === 0) {
      return { items: [], generated_at: new Date().toISOString() };
    }
    const orPairs = groups
      .filter((g) => g._max.computed_at != null)
      .map((g) => ({
        user_id: g.user_id,
        computed_at: g._max.computed_at as Date,
      }));

    const predictions = await this.prisma.ptmPrediction.findMany({
      where: { OR: orPairs },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            ptm_signals: {
              select: { recorded_at: true },
              orderBy: { recorded_at: 'desc' },
              take: 1,
            },
          },
        },
      },
    });

    // Filter by bucket (amber = risk > 0.3 <=0.6, red = risk > 0.6).
    const atRisk = predictions.filter((p) => {
      if (opts.minBucket === 'red') return p.risk_score > 0.6;
      return p.risk_score > 0.3;
    });
    if (atRisk.length === 0) {
      return { items: [], generated_at: new Date().toISOString() };
    }

    const atRiskIds = atRisk.map((p) => p.user_id);
    const bloodworkAlerts = await this.prisma.coachAlert.findMany({
      where: {
        coach_id: coachId,
        client_id: { in: atRiskIds },
        alert_type: 'bloodwork_review',
        acknowledged_at: null,
      },
      select: { client_id: true },
    });
    const bloodworkSet = new Set(bloodworkAlerts.map((a) => a.client_id));

    const now = Date.now();
    const items: ChurnAtRiskEntry[] = atRisk
      .sort((a, b) => b.risk_score - a.risk_score)
      .slice(0, limit)
      .map((p) => {
        const factors = parseFactors(p.factors);
        const topFactors = factors.slice(0, 3);
        const lastSignal = p.user.ptm_signals[0]?.recorded_at ?? null;
        const lastSignalMs = lastSignal ? lastSignal.getTime() : null;
        const daysSince =
          lastSignalMs != null
            ? Math.max(0, Math.floor((now - lastSignalMs) / 86_400_000))
            : 0;

        const signals = topFactors.map((f) => ({
          key: f.key,
          label: f.label,
          severity:
            f.contribution >= 0.15
              ? ('high' as const)
              : f.contribution > 0
                ? ('medium' as const)
                : ('protective' as const),
        }));

        const bucket: 'red' | 'amber' =
          p.risk_score > 0.6 ? 'red' : 'amber';
        const hasBloodwork = bloodworkSet.has(p.user_id);

        return {
          user_id: p.user_id,
          display_name: nameMap.get(p.user_id) ?? p.user.name,
          bucket,
          risk_score: null,
          last_active_at: lastSignal ? lastSignal.toISOString() : null,
          days_since_last_signal: daysSince,
          risk_signals: signals,
          top_factor: topFactors[0]?.label ?? 'Multiple risk signals detected',
          suggested_action: hasBloodwork
            ? 'review_bloodwork'
            : signals.length === 0
              ? 'none'
              : 'send_checkin_message',
          score_computed_at: p.computed_at.toISOString(),
        };
      });

    return { items, generated_at: new Date().toISOString() };
  }

  // ── POST /churn-at-risk/:clientId/draft ──────────────────────────────
  async generateChurnDraft(
    coachId: string,
    clientId: string,
    dto: { idempotency_key: string; alert_id?: string },
  ): Promise<ChurnInterventionDto> {
    if (!dto || !dto.idempotency_key || !UUID_RE.test(dto.idempotency_key)) {
      throw new BadRequestException('idempotency_key must be a valid UUID');
    }

    // IDOR check — clientId must be in this coach's roster.
    const client = await this.prisma.user.findFirst({
      where: {
        id: clientId,
        coach_id: coachId,
        role: 'student',
        deleted_at: null,
      },
      select: { id: true, name: true },
    });
    if (!client) throw new NotFoundException('Client not found');

    // Pull PTM context (used both for the prompt and as the row's
    // top_factor / risk_score_at_draft snapshot).
    const latestPrediction = await this.ptm.getLatestPrediction(clientId);
    const factors = parseFactors(latestPrediction?.factors);
    const topFactor = factors[0]?.label ?? 'Declining engagement';
    const riskScore = latestPrediction?.risk_score ?? null;

    // Atomic idempotency claim: try to insert a `draft_pending` row with
    // the idempotency key as the unique constraint. The winner proceeds
    // to call Anthropic; concurrent losers hit P2002 and read back the
    // existing row instead of double-billing the API. This replaces the
    // earlier check-then-act pattern.
    let claimed;
    try {
      claimed = await this.prisma.churnIntervention.create({
        data: {
          coach_id: coachId,
          client_id: clientId,
          draft_text: '',
          status: 'draft_pending',
          alert_id: dto.alert_id ?? null,
          risk_score_at_draft: riskScore,
          top_factor: topFactor,
          idempotency_key: dto.idempotency_key,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Loser: another caller already claimed this key. Return the
        // existing row in whatever state it's in (the winner will
        // finalize it; the client can poll). Scope to coach to prevent
        // cross-coach replay.
        const existing = await this.prisma.churnIntervention.findUnique({
          where: { idempotency_key: dto.idempotency_key },
          include: { client: { select: { name: true } } },
        });
        if (!existing) {
          throw new ConflictException('idempotency_key already in use');
        }
        // Require BOTH coach and client to match for a true idempotent
        // replay. Same coach reusing the same key against a different
        // client must NOT return client A's intervention while the URL
        // targeted client B.
        if (
          existing.coach_id !== coachId ||
          existing.client_id !== clientId
        ) {
          throw new ConflictException(
            'idempotency_key already in use for a different client',
          );
        }
        return this.toDto(existing, existing.client?.name ?? client.name);
      }
      throw err;
    }

    const recentCheckIn = await this.prisma.checkIn.findFirst({
      where: { user_id: clientId },
      orderBy: { logged_at: 'desc' },
      select: {
        mood: true,
        energy: true,
        notes: true,
        logged_at: true,
      },
    });

    const coach = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: {
        name: true,
        coach_profile: { select: { timezone: true } },
      },
    });
    const coachTimeZone =
      coach?.coach_profile?.timezone ?? 'America/Los_Angeles';

    // Winner: generate AI draft. On failure mark the row failed so the
    // status reflects reality, then surface a sanitized 503.
    let draftText: string;
    try {
      draftText = await this.draftWithAnthropic({
        clientName: client.name,
        topFactor,
        topFactors: factors.slice(0, 3).map((f) => f.label),
        recentCheckIn,
        coachName: coach?.name ?? 'Your coach',
        timeZone: coachTimeZone,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Churn draft generation failed coach=${coachId} client=${clientId}: ${msg}`,
      );
      try {
        await this.prisma.churnIntervention.update({
          where: { id: claimed.id },
          data: { status: 'draft_failed' },
        });
      } catch (markErr) {
        this.logger.warn(
          `Failed to mark intervention=${claimed.id} draft_failed: ${markErr instanceof Error ? markErr.message : String(markErr)}`,
        );
      }
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'AI_GENERATION_FAILED',
        message:
          'Unable to generate message draft right now. Please try again.',
      });
    }

    const intervention = await this.prisma.churnIntervention.update({
      where: { id: claimed.id },
      data: {
        draft_text: draftText,
        status: 'draft',
      },
    });

    return this.toDto(intervention, client.name);
  }

  // ── POST /churn-interventions/:id/send ───────────────────────────────
  async sendIntervention(
    coachId: string,
    interventionId: string,
    dto: { message_text: string; idempotency_key: string },
  ): Promise<SendInterventionResponse> {
    if (!dto || !dto.idempotency_key || !UUID_RE.test(dto.idempotency_key)) {
      throw new BadRequestException('idempotency_key must be a valid UUID');
    }
    const text = (dto.message_text ?? '').trim();
    if (!text) {
      throw new BadRequestException(
        `message_text must be 1–${MAX_MESSAGE_CHARS} characters`,
      );
    }
    if (text.length > MAX_MESSAGE_CHARS) {
      throw new BadRequestException(
        `message_text must be 1–${MAX_MESSAGE_CHARS} characters`,
      );
    }

    const intervention = await this.prisma.churnIntervention.findFirst({
      where: { id: interventionId, coach_id: coachId },
    });
    if (!intervention) throw new NotFoundException('Intervention not found');

    // Send-idempotency replay: if this exact send_idempotency_key was
    // already persisted for this coach, return the existing send result
    // verbatim (true idempotency — same key + same outcome regardless of
    // current message text). Scope to coach to defuse cross-coach replay.
    const replay = await this.prisma.churnIntervention.findFirst({
      where: {
        send_idempotency_key: dto.idempotency_key,
        coach_id: coachId,
      },
    });
    if (replay) {
      if (replay.id !== interventionId) {
        throw new ConflictException('idempotency_key already in use');
      }
      if (replay.status === 'sent' && replay.sent_at && replay.nudge_id) {
        return {
          ok: true,
          intervention_id: replay.id,
          sent_at: replay.sent_at.toISOString(),
          nudge_id: replay.nudge_id,
        };
      }
    }

    // Already sent (under a different key, or pre-key history)? Return
    // existing state (idempotent).
    if (
      intervention.status === 'sent' &&
      intervention.sent_at &&
      intervention.nudge_id
    ) {
      return {
        ok: true,
        intervention_id: interventionId,
        sent_at: intervention.sent_at.toISOString(),
        nudge_id: intervention.nudge_id,
      };
    }
    if (intervention.status === 'dismissed') {
      throw new ConflictException('Cannot send a dismissed intervention');
    }

    const sentAt = new Date();
    const editedText =
      text !== intervention.draft_text ? text : null;
    const nudgeId = randomUUID();

    // Interactive transaction: claim the row atomically, then create the
    // CoachNudge and write its id back in the same transaction. If
    // updateMany returns count: 0 (race loser), abort early — no nudge
    // is ever created. If anything inside the callback throws, Prisma
    // rolls the whole transaction back.
    // Sentinel used to surface an idempotent-replay result from inside
    // the transaction callback without committing a no-op write. Thrown
    // when claim.count === 0 and the fresh row is the same caller's
    // already-committed send (same send_idempotency_key + non-null
    // nudge_id), then caught right outside the transaction.
    type ReplayHit = {
      __replay: true;
      sent_at: Date;
      nudge_id: string;
    };
    const isReplayHit = (e: unknown): e is ReplayHit =>
      typeof e === 'object' &&
      e !== null &&
      (e as { __replay?: unknown }).__replay === true;

    try {
      await this.prisma.$transaction(async (tx) => {
        const claim = await tx.churnIntervention.updateMany({
          where: {
            id: interventionId,
            coach_id: coachId,
            status: { notIn: ['sent', 'dismissed'] },
          },
          data: {
            status: 'sent',
            edited_text: editedText,
            sent_at: sentAt,
            send_idempotency_key: dto.idempotency_key,
            nudge_id: nudgeId,
          },
        });

        if (claim.count === 0) {
          // Lost the race — another sender or a dismiss already won. Read
          // back to distinguish so the caller gets a precise error.
          const fresh = await tx.churnIntervention.findFirst({
            where: { id: interventionId, coach_id: coachId },
          });
          if (!fresh) throw new NotFoundException('Intervention not found');
          if (fresh.status === 'sent') {
            // Same idempotency key + committed nudge = this is a replay
            // of *our own* in-flight send that won the race. Surface the
            // committed result as success rather than 409.
            if (
              fresh.send_idempotency_key === dto.idempotency_key &&
              fresh.nudge_id &&
              fresh.sent_at
            ) {
              const replay: ReplayHit = {
                __replay: true,
                sent_at: fresh.sent_at,
                nudge_id: fresh.nudge_id,
              };
              throw replay;
            }
            throw new ConflictException('Intervention already sent');
          }
          if (fresh.status === 'dismissed') {
            throw new ConflictException('Cannot send a dismissed intervention');
          }
          throw new ConflictException(
            'Intervention is no longer in a sendable state',
          );
        }

        await tx.coachNudge.create({
          data: {
            id: nudgeId,
            coach_id: coachId,
            client_id: intervention.client_id,
            title: 'Message from your coach',
            body: text,
          },
        });
      });
    } catch (err) {
      if (isReplayHit(err)) {
        return {
          ok: true,
          intervention_id: interventionId,
          sent_at: err.sent_at.toISOString(),
          nudge_id: err.nudge_id,
        };
      }
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Concurrent send with same key just won. Re-fetch and return
        // the existing send result.
        const fresh = await this.prisma.churnIntervention.findFirst({
          where: { id: interventionId, coach_id: coachId },
        });
        if (
          fresh?.status === 'sent' &&
          fresh.sent_at &&
          fresh.nudge_id
        ) {
          return {
            ok: true,
            intervention_id: interventionId,
            sent_at: fresh.sent_at.toISOString(),
            nudge_id: fresh.nudge_id,
          };
        }
        throw new ConflictException('idempotency_key already in use');
      }
      throw err;
    }

    // Fire push AFTER the transaction commits. Failure cannot un-send
    // the message; we log and move on.
    if (this.notifications) {
      void this.notifications
        .pushToUser(intervention.client_id, 'Message from your coach', text.slice(0, 120), {
          type: 'coach_nudge',
          nudge_id: nudgeId,
        })
        .catch((err) => {
          this.logger.warn(
            `Push failed for nudge=${nudgeId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }

    return {
      ok: true,
      intervention_id: interventionId,
      sent_at: sentAt.toISOString(),
      nudge_id: nudgeId,
    };
  }

  // ── POST /churn-interventions/:id/dismiss ────────────────────────────
  async dismissIntervention(
    coachId: string,
    interventionId: string,
  ): Promise<{ ok: true; intervention_id: string }> {
    // Single atomic conditional write. Always include coach_id to enforce
    // ownership and guard against IDOR; the WHERE clause ensures only
    // non-terminal statuses can transition. If count === 0, the row
    // either doesn't belong to this coach, doesn't exist, was already
    // dismissed (idempotent OK), or a concurrent send won the race
    // (must surface as 409 — we cannot lie to the client).
    const result = await this.prisma.churnIntervention.updateMany({
      where: {
        id: interventionId,
        coach_id: coachId,
        status: { notIn: ['sent', 'dismissed'] },
      },
      data: { status: 'dismissed', dismissed_at: new Date() },
    });
    if (result.count === 0) {
      const row = await this.prisma.churnIntervention.findFirst({
        where: { id: interventionId, coach_id: coachId },
      });
      if (!row) throw new NotFoundException('Intervention not found');
      if (row.status === 'dismissed') {
        return { ok: true, intervention_id: interventionId };
      }
      if (row.status === 'sent') {
        throw new ConflictException(
          'Intervention already sent — cannot dismiss',
        );
      }
      throw new ConflictException('Intervention is no longer dismissable');
    }
    return { ok: true, intervention_id: interventionId };
  }

  // ── Anthropic call with timeout ──────────────────────────────────────
  private async draftWithAnthropic(ctx: {
    clientName: string;
    topFactor: string;
    topFactors: string[];
    recentCheckIn: {
      mood: number | null;
      energy: number | null;
      notes: string | null;
      logged_at: Date;
    } | null;
    coachName: string;
    timeZone: string;
  }): Promise<string> {
    const client = this.getAnthropicClient();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);

    const signalList = ctx.topFactors.length
      ? ctx.topFactors.map((f) => `- ${f}`).join('\n')
      : `- ${ctx.topFactor}`;

    const lastCheckIn = ctx.recentCheckIn
      ? `Their most recent check-in was on ${bucketDateLocal(ctx.recentCheckIn.logged_at, ctx.timeZone)}. Mood: ${ctx.recentCheckIn.mood ?? 'not rated'}. Energy: ${ctx.recentCheckIn.energy ?? 'not rated'}.`
      : 'They have no recent check-in data.';

    const system = `You are a fitness coach assistant. Write a warm, supportive re-engagement message from a coach to a client who shows signs of disengaging.

Coach name: ${ctx.coachName}
Client name: ${ctx.clientName}

Risk signals detected:
${signalList}

${lastCheckIn}

Write a brief (2-4 sentences), personal, non-pushy message that:
- Acknowledges the client by name
- Shows the coach has noticed their absence without being accusatory
- Offers support or asks a simple open question
- Signs off warmly with the coach's name

Do not use generic phrases like "I noticed you haven't logged in." Be specific to the signals.
Do not include any markdown formatting. Write in plain conversational text.
Output ONLY the message text — no preamble, no explanation.`;

    try {
      const resp = await client.messages.create(
        {
          model: COACH_AI_MODEL,
          max_tokens: 400,
          temperature: 0.7,
          system,
          messages: [
            {
              role: 'user',
              content: `Write the message for ${ctx.clientName}.`,
            },
          ],
        },
        { signal: controller.signal },
      );

      const block = resp.content?.find?.((b) => b.type === 'text');
      const text =
        block && block.type === 'text' ? block.text.trim() : '';

      if (!text) {
        throw new Error('Empty Anthropic response');
      }
      // Defense in depth: clamp to MAX_MESSAGE_CHARS so a chatty model
      // can't break the downstream column or push notification.
      return text.length > MAX_MESSAGE_CHARS
        ? text.slice(0, MAX_MESSAGE_CHARS)
        : text;
    } finally {
      clearTimeout(timer);
    }
  }

  private toDto(
    row: {
      id: string;
      client_id: string;
      draft_text: string;
      status: string;
      top_factor: string | null;
      created_at: Date;
    },
    clientName: string,
  ): ChurnInterventionDto {
    return {
      intervention_id: row.id,
      client_id: row.client_id,
      client_name: clientName,
      draft_text: row.draft_text,
      status: (row.status as ChurnInterventionDto['status']) ?? 'draft',
      top_factor: row.top_factor ?? 'Declining engagement',
      created_at: row.created_at.toISOString(),
    };
  }
}
