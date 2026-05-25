// src/coach/brief/coach-brief.service.ts
//
// CoachBriefService — R43.
//
// Generates the daily Coach Brief: detect mode → aggregate scoped client
// data → call Claude with a mode-aware system prompt → store in CoachBrief.
// One row per (coach_id, brief_date); generation is idempotent — repeat
// calls return the cached row.
//
// R39 cross-cutting compliance:
//   * RLS              — CoachBrief table is server-only (no INSERT/UPDATE
//                        policy for the coach client); see migration.
//   * Idempotency      — unique (coach_id, brief_date); generateBrief checks
//                        status='generated' before regenerating.
//   * Timeouts         — Anthropic call wrapped in AbortController, 15s.
//   * Sanitization     — Claude errors never propagate to the caller; we log
//                        internally and fall back to a deterministic narrative.
//   * Date bucketing   — ALWAYS bucketDateLocal(d, tz); never toISOString().
//   * ConfigService    — ANTHROPIC_API_KEY read only via this.config.get<>().

import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../../prisma.service';
import {
  ActionItem,
  BriefContext,
  BriefContextHeadCoach,
  BriefMode,
  BriefSummary,
  CoachBriefResponse,
  SubCoachHighlight,
} from './coach-brief.types';

// DI token so tests can inject a fake Anthropic client without reaching
// out to the public API.
export const BRIEF_ANTHROPIC_CLIENT_TOKEN = 'BRIEF_ANTHROPIC_CLIENT';

export const BRIEF_CLAUDE_MODEL = 'claude-3-5-sonnet-20241022';
export const BRIEF_MAX_TOKENS = 300;
export const BRIEF_TEMPERATURE = 0.6;
export const BRIEF_ANTHROPIC_TIMEOUT_MS = 15_000;
export const BRIEF_MAX_NARRATIVE_CHARS = 600;

// WeightLog stores `weight_lbs`; 2.0 kg ≈ 4.4 lbs is the flag threshold.
const WEIGHT_FLAG_THRESHOLD_LBS = 4.4;

// Format a Date as YYYY-MM-DD in the given IANA timezone. Uses
// Intl.DateTimeFormat with an explicit `timeZone` so production hosts
// running with TZ=UTC (Fly.io) still bucket dates in the coach's local
// timezone. Never use toISOString().slice(0,10) — that returns the UTC
// date — and never use Date#getFullYear/Month/Date (process tz).
export function bucketDateLocal(
  d: Date,
  timeZone = 'America/Los_Angeles',
): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    // Invalid IANA tz (should be blocked at DTO write time but a stale
    // row could still trip this). Fall back to UTC bucketing rather than
    // crash the caller.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  }
}

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ─── Pure prompt builders (exported for tests) ──────────────────────────

export function buildSoloCoachSystemPrompt(): string {
  return `You are TGP — a smart AI platform that actively manages a fitness coach's business in the background. Your job is to write the coach's daily brief: a short, warm paragraph (3–5 sentences) delivered each morning.

Voice and tone rules — these are mandatory:
- Write in first-person plural as TGP ("we", "we've", "we're"). You are the platform speaking, not a third party.
- Address the coach by their first name in the opening sentence.
- Lead with wins and momentum — who checked in, what progress clients made, any money that came in.
- When TGP is actively handling something in the background (retrying a payment, flagging a weight log, sending a reminder), say so explicitly: "we're working on it", "we flagged this", "we've already sent the retry", "you don't need to do anything on that one."
- End with a natural handoff sentence that signals the action items below. Match the count to the actual number of items: "Here's what needs your quick approval:", "Three things need your eyes:", "Just two things from you today:"
- 3–5 sentences MAXIMUM.
- No bullet points, no markdown, no headers.
- Do not start with "Here is your brief" or any meta-phrase. Start directly with the coach's name.
- Output ONLY the brief text. Nothing else.`;
}

export function buildHeadCoachSystemPrompt(): string {
  return `You are TGP — a smart AI platform that runs the back office for a fitness coaching business. Your job is to write the head coach's daily business brief: a short, confident paragraph (3–5 sentences) delivered each morning.

This coach runs a team. Lead with the business — revenue, team performance, growth — before individual client details.

Voice and tone rules — these are mandatory:
- Write in first-person plural as TGP ("we", "we've", "we're"). You are the platform managing the business.
- Address the coach by their first name in the opening sentence.
- Lead with revenue and team wins: what the team collected today, how the month is tracking, which sub-coach is performing.
- When TGP is actively handling failed payments or dunning, make it clear: "we're chasing down X from 2 clients", "you don't need to do anything on that."
- If sub-coach highlights exist (new clients added, strong performance), weave them in naturally.
- End with a natural handoff to action items: "Here's what needs your attention:", "Two things from you today:", etc.
- Tone is like a COO briefing, not a personal trainer. Confident, data-forward, brief.
- 3–5 sentences MAXIMUM. No bullets, no markdown, no headers.
- Do not start with "Here is your brief". Start directly with the coach's name.
- Output ONLY the brief text.`;
}

export function buildBriefPrompt(
  ctx: BriefContext | BriefContextHeadCoach,
): string {
  const actionCount =
    ctx.workouts_pending_approval +
    ctx.weight_logs_flagged +
    ctx.unread_messages +
    (ctx.missed_checkin > 0 ? 1 : 0);

  const handoffHint =
    actionCount === 0
      ? 'No action items today.'
      : actionCount === 1
        ? 'End with a handoff to 1 action item.'
        : `End with a handoff to ${actionCount} action items.`;

  const parts: string[] = [
    `Coach first name: ${ctx.coach_first_name}`,
    `Coach full name: ${ctx.coach_name}`,
    `Date: ${ctx.date}`,
    ``,
    `--- CLIENT DATA (own direct clients) ---`,
    `Roster size: ${ctx.roster_size} active clients`,
    `Check-ins received today: ${ctx.checked_in_today} of ${ctx.roster_size}`,
    `Missing check-ins: ${ctx.missed_checkin}`,
    `Workouts waiting for approval: ${ctx.workouts_pending_approval}`,
    `Workouts approved today: ${ctx.workouts_approved_today}`,
    `Unread messages: ${ctx.unread_messages}`,
    `Weight log flags (large delta): ${ctx.weight_logs_flagged}`,
    ``,
    `--- PAYMENTS / TGP HANDLING ---`,
    `Payments received today: ${ctx.paid_today_count} payment(s), $${(ctx.revenue_today_cents / 100).toFixed(0)} total`,
    `Healthy renewals in next 7 days: ${ctx.renewals_upcoming_7d}`,
    `Failed payments TGP is retrying (dunning active): ${ctx.dunning_in_progress}`,
    ctx.dunning_in_progress > 0
      ? `→ Say: "We're working on getting the ${ctx.dunning_in_progress} failed payment${ctx.dunning_in_progress > 1 ? 's' : ''} sorted — you don't need to do anything."`
      : `→ No dunning in progress.`,
  ];

  if (ctx.brief_mode === 'head_coach') {
    const hc = ctx as BriefContextHeadCoach;
    parts.push(
      ``,
      `--- TEAM BUSINESS METRICS (entire team, all sub-coaches + own clients) ---`,
      `Team size: ${hc.team_size} active sub-coaches`,
      `Total active clients across team: ${hc.team_clients_total}`,
      `Team revenue today: $${(hc.total_revenue_today_cents / 100).toFixed(0)}`,
      `Team revenue last 30 days: $${(hc.team_revenue_30d_cents / 100).toFixed(0)}`,
      `Projected MRR (active subscriptions): $${(hc.mrr_projected_cents / 100).toFixed(0)}`,
      `Failed payments TGP is retrying (team-wide dollar value): $${(hc.dunning_amount_cents / 100).toFixed(0)}`,
      `New clients in last 24h (team-wide): ${hc.new_clients_last_24h}`,
      ``,
      `Sub-coach highlights (top 3 by active clients):`,
      ...hc.sub_coach_highlights.map(
        (sc) =>
          `  - ${sc.coach_name}: ${sc.active_clients} clients, +${sc.new_clients_24h} new in 24h`,
      ),
      ``,
      `→ Lead with team revenue and TGP dunning handling. Mention sub-coach highlights if notable. This coach wants a COO-level view.`,
    );
  }

  parts.push(``, handoffHint);
  return parts.join('\n');
}

export function buildFallbackNarrative(
  ctx: BriefContext | BriefContextHeadCoach,
): string {
  const total =
    ctx.workouts_pending_approval +
    ctx.missed_checkin +
    ctx.weight_logs_flagged +
    ctx.unread_messages;

  if (total === 0) {
    return `All clear today, ${ctx.coach_first_name} — ${ctx.checked_in_today} client${ctx.checked_in_today === 1 ? '' : 's'} ${ctx.checked_in_today === 1 ? 'has' : 'have'} checked in and nothing needs your immediate attention.`;
  }

  const parts: string[] = [];
  if (ctx.workouts_pending_approval > 0) {
    parts.push(
      `${ctx.workouts_pending_approval} workout${ctx.workouts_pending_approval > 1 ? 's' : ''} waiting on approval`,
    );
  }
  if (ctx.missed_checkin > 0) {
    parts.push(
      `${ctx.missed_checkin} client${ctx.missed_checkin > 1 ? 's' : ''} ${ctx.missed_checkin > 1 ? "haven't" : "hasn't"} checked in yet`,
    );
  }
  if (ctx.unread_messages > 0) {
    parts.push(
      `${ctx.unread_messages} unread message${ctx.unread_messages > 1 ? 's' : ''}`,
    );
  }
  if (ctx.weight_logs_flagged > 0) {
    parts.push(
      `${ctx.weight_logs_flagged} weight log${ctx.weight_logs_flagged > 1 ? 's' : ''} need${ctx.weight_logs_flagged > 1 ? '' : 's'} a look`,
    );
  }

  return `${ctx.coach_first_name}, you have ${total} thing${total > 1 ? 's' : ''} to review today — ${parts.join(', ')}.`;
}

// Deterministic — NOT AI-generated. Sorted ascending by priority.
export function buildActionItems(args: {
  pendingWorkouts: Array<{
    id: string;
    client_id: string;
    client_name: string;
    plan_name: string;
  }>;
  unreadThreads: Array<{
    client_id: string;
    client_name: string;
    message_preview: string;
  }>;
  flaggedWeightLogs: Array<{
    client_id: string;
    client_name: string;
    delta_lbs: number;
  }>;
  missingCheckinClients: Array<{ id: string; name: string }>;
}): ActionItem[] {
  const items: ActionItem[] = [];

  for (const w of args.pendingWorkouts) {
    items.push({
      type: 'workout_approval',
      client_id: w.client_id,
      client_name: w.client_name,
      detail: `${w.plan_name} needs approval`,
      priority: 1,
      deep_link: `tgp://workout/approval/${w.id}`,
    });
  }

  for (const t of args.unreadThreads) {
    items.push({
      type: 'message_unread',
      client_id: t.client_id,
      client_name: t.client_name,
      detail: t.message_preview.slice(0, 80),
      priority: 1,
      deep_link: `tgp://messages/${t.client_id}`,
    });
  }

  for (const w of args.flaggedWeightLogs) {
    items.push({
      type: 'weight_flag',
      client_id: w.client_id,
      client_name: w.client_name,
      detail: `Weight change of ${Math.abs(w.delta_lbs).toFixed(1)} lbs needs review`,
      priority: 2,
      deep_link: `tgp://client/${w.client_id}/weight`,
    });
  }

  for (const c of args.missingCheckinClients.slice(0, 5)) {
    items.push({
      type: 'checkin_missing',
      client_id: c.id,
      client_name: c.name,
      detail: 'Has not checked in today',
      priority: 3,
      deep_link: `tgp://client/${c.id}`,
    });
  }

  return items.sort(
    (a, b) => a.priority - b.priority || a.type.localeCompare(b.type),
  );
}

// ─── Service ────────────────────────────────────────────────────────────

@Injectable()
export class CoachBriefService {
  private readonly logger = new Logger(CoachBriefService.name);
  private anthropic: Anthropic | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional()
    @Inject(BRIEF_ANTHROPIC_CLIENT_TOKEN)
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

  // ── Resolves the coach's timezone for date bucketing. Defaults to
  // 'America/Los_Angeles' when no preferences row exists yet. If a
  // historically-persisted preferences row holds an invalid IANA tz
  // (pre-validator), fall back to UTC with a warning instead of letting
  // it crash Intl.DateTimeFormat downstream.
  async resolveCoachTimezone(coachId: string): Promise<string> {
    const prefs = await this.prisma.coachBriefPreferences.findUnique({
      where: { coach_id: coachId },
      select: { timezone: true },
    });
    const tz = prefs?.timezone ?? 'America/Los_Angeles';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    } catch {
      this.logger.warn(
        `coach=${coachId} has invalid timezone="${tz}" — falling back to UTC`,
      );
      return 'UTC';
    }
  }

  // ── Detect brief mode (solo_coach | head_coach | sub_coach).
  // sub_coach takes precedence — if a coach appears in both directions
  // (head of one team, sub of another), we render the sub-coach brief so
  // the client scope stays narrow.
  async detectBriefMode(coachId: string): Promise<BriefMode> {
    const subAssignment = await this.prisma.teamSubCoachAssignment.findFirst({
      where: { sub_coach_id: coachId, archived_at: null },
      select: { id: true },
    });
    if (subAssignment) return 'sub_coach';

    const subCoachCount = await this.prisma.teamSubCoachAssignment.count({
      where: { head_coach_id: coachId, archived_at: null },
    });
    return subCoachCount > 0 ? 'head_coach' : 'solo_coach';
  }

  // ── Resolve which client ids are in this coach's scope. Sub-coaches see
  // only clients with an OPEN SubCoachAssignment (the canonical
  // authorization source); head coaches + solo coaches see their full
  // direct roster.
  async resolveClientScope(coachId: string, briefMode: BriefMode): Promise<string[]> {
    if (briefMode === 'sub_coach') {
      const assignments = await this.prisma.subCoachAssignment.findMany({
        where: { sub_coach_id: coachId, unassigned_at: null },
        select: { client_id: true },
      });
      if (assignments.length === 0) return [];
      const ids = Array.from(new Set(assignments.map((a) => a.client_id)));
      const live = await this.prisma.user.findMany({
        where: { id: { in: ids }, role: 'student', archived_at: null },
        select: { id: true },
      });
      return live.map((u) => u.id);
    }

    const clients = await this.prisma.user.findMany({
      where: {
        coach_id: coachId,
        archived_at: null,
        role: 'student',
      },
      select: { id: true },
    });
    return clients.map((c) => c.id);
  }

  // ── Solo + sub-coach aggregation. Returns a BriefContext with brief_mode
  // left to the caller to set (so we share the same code path for both).
  private async aggregateSoloContext(
    coachId: string,
    clientIds: string[],
    timezone: string,
    briefDate: string,
    briefMode: BriefMode = 'solo_coach',
  ): Promise<{
    context: BriefContext;
    pendingWorkouts: Array<{
      id: string;
      client_id: string;
      client_name: string;
      plan_name: string;
    }>;
    unreadThreads: Array<{
      client_id: string;
      client_name: string;
      message_preview: string;
    }>;
    flaggedWeightLogs: Array<{
      client_id: string;
      client_name: string;
      delta_lbs: number;
    }>;
    missingCheckinClients: Array<{ id: string; name: string }>;
  }> {
    const briefDateStart = startOfDayInTz(briefDate, timezone);
    const briefDateEnd = endOfDayInTz(briefDate, timezone);
    const briefDateOnly = new Date(`${briefDate}T00:00:00.000Z`); // CheckIn.date is a Postgres DATE, no tz
    const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Coach metadata — needed first because Claude prompts use the name.
    const coachRow = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { name: true },
    });
    const coachName = coachRow?.name ?? 'Coach';
    const coachFirstName = coachName.split(' ')[0] || coachName;

    if (clientIds.length === 0) {
      return {
        context: {
          brief_mode: 'solo_coach',
          date: briefDate,
          checked_in_today: 0,
          missed_checkin: 0,
          workouts_pending_approval: 0,
          workouts_approved_today: 0,
          paid_today_count: 0,
          revenue_today_cents: 0,
          renewals_upcoming_7d: 0,
          dunning_in_progress: 0,
          weight_logs_flagged: 0,
          unread_messages: 0,
          coach_name: coachName,
          coach_first_name: coachFirstName,
          roster_size: 0,
        },
        pendingWorkouts: [],
        unreadThreads: [],
        flaggedWeightLogs: [],
        missingCheckinClients: [],
      };
    }

    const [
      checkedInToday,
      pendingWorkoutsRaw,
      workoutsApprovedToday,
      paidTodayAgg,
      renewalsUpcoming7d,
      dunningInProgressRaw,
      flaggedWeightRaw,
      unreadMessagesRaw,
      missingCheckinRaw,
    ] = await Promise.all([
      this.prisma.checkIn.findMany({
        where: { user_id: { in: clientIds }, date: briefDateOnly },
        select: { user_id: true },
        distinct: ['user_id'],
      }),
      this.prisma.clientWorkoutAssignment.findMany({
        where: {
          client_id: { in: clientIds },
          completed_at: { not: null },
          approved_by_coach_at: null,
          // In sub-coach mode, restrict action items to workouts the
          // sub-coach actually assigned. Without this, a sub-coach could
          // see head-coach pending approvals for their scoped clients.
          ...(briefMode === 'sub_coach' ? { assigned_by_coach_id: coachId } : {}),
        },
        select: {
          id: true,
          client_id: true,
          client: { select: { name: true } },
          workout_plan: { select: { name: true } },
        },
        take: 50,
      }),
      this.prisma.clientWorkoutAssignment.count({
        where: {
          assigned_by_coach_id: coachId,
          approved_by_coach_at: { gte: briefDateStart, lte: briefDateEnd },
        },
      }),
      this.prisma.clientPurchase.aggregate({
        _sum: { amount_cents: true },
        _count: { _all: true },
        where: {
          coach_user_id: coachId,
          status: 'paid',
          updated_at: { gte: briefDateStart, lte: briefDateEnd },
        },
      }),
      this.prisma.clientPurchase.count({
        where: {
          coach_user_id: coachId,
          entitlement_active: true,
          billing_type: 'recurring',
          current_period_end: { gte: new Date(), lte: sevenDaysOut },
          dunning: { is: null },
        },
      }),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(
        Prisma.sql`
          SELECT COUNT(*)::bigint AS count
          FROM "DunningState" ds
          JOIN "ClientPurchase" cp ON cp."id" = ds."purchase_id"
          WHERE ds."status" = 'active'
            AND cp."coach_user_id" = ${coachId}
        `,
      ),
      this.prisma.$queryRaw<
        Array<{ user_id: string; user_name: string; delta_lbs: number }>
      >(
        Prisma.sql`
          WITH ranked AS (
            SELECT
              "user_id",
              "weight_lbs",
              ROW_NUMBER() OVER (PARTITION BY "user_id" ORDER BY "logged_at" DESC) AS rn
            FROM "WeightLog"
            WHERE "user_id" = ANY(${clientIds}::text[])
          )
          SELECT
            r1."user_id"      AS user_id,
            u."name"          AS user_name,
            (r1."weight_lbs" - r2."weight_lbs")::float AS delta_lbs
          FROM ranked r1
          JOIN ranked r2 ON r2."user_id" = r1."user_id" AND r2.rn = 2
          JOIN "User" u ON u."id" = r1."user_id"
          WHERE r1.rn = 1
            AND ABS(r1."weight_lbs" - r2."weight_lbs") >= ${WEIGHT_FLAG_THRESHOLD_LBS}
        `,
      ),
      this.prisma.coachMessage.findMany({
        where: {
          coach_id: coachId,
          read_at: null,
          // The coach has not read the message and the sender is NOT the
          // coach — i.e. the message came from the client. NOT(sender=coach)
          // tolerates the SetNull on sender_id by treating null senders as
          // not-coach (rare edge after GDPR scrub).
          NOT: { sender_id: coachId },
        },
        select: {
          client_id: true,
          client: { select: { name: true } },
          body: true,
          created_at: true,
        },
        orderBy: { created_at: 'desc' },
        // dedupe by client below
        take: 100,
      }),
      this.prisma.user.findMany({
        where: {
          id: { in: clientIds },
          check_ins: { none: { date: briefDateOnly } },
        },
        select: { id: true, name: true },
        take: 50,
      }),
    ]);

    const checkedInCount = checkedInToday.length;

    // Group unread messages by client (one thread per client; preview is the
    // most-recent inbound body)
    const threadByClient = new Map<
      string,
      { client_id: string; client_name: string; message_preview: string }
    >();
    for (const m of unreadMessagesRaw) {
      if (!m.client_id || threadByClient.has(m.client_id)) continue;
      threadByClient.set(m.client_id, {
        client_id: m.client_id,
        client_name: m.client?.name ?? 'Client',
        message_preview: m.body ?? '(voice message)',
      });
    }
    const unreadThreads = Array.from(threadByClient.values());

    const flaggedWeightLogs = flaggedWeightRaw.map((r) => ({
      client_id: r.user_id,
      client_name: r.user_name,
      delta_lbs: r.delta_lbs,
    }));

    const pendingWorkouts = pendingWorkoutsRaw.map((w) => ({
      id: w.id,
      client_id: w.client_id,
      client_name: w.client?.name ?? 'Client',
      plan_name: w.workout_plan?.name ?? 'Workout',
    }));

    const dunningInProgress = Number(dunningInProgressRaw[0]?.count ?? 0);

    const context: BriefContext = {
      brief_mode: 'solo_coach',
      date: briefDate,
      checked_in_today: checkedInCount,
      missed_checkin: Math.max(0, clientIds.length - checkedInCount),
      workouts_pending_approval: pendingWorkoutsRaw.length,
      workouts_approved_today: workoutsApprovedToday,
      paid_today_count: paidTodayAgg._count._all,
      revenue_today_cents: paidTodayAgg._sum.amount_cents ?? 0,
      renewals_upcoming_7d: renewalsUpcoming7d,
      dunning_in_progress: dunningInProgress,
      weight_logs_flagged: flaggedWeightLogs.length,
      unread_messages: unreadThreads.length,
      coach_name: coachName,
      coach_first_name: coachFirstName,
      roster_size: clientIds.length,
    };

    return {
      context,
      pendingWorkouts,
      unreadThreads,
      flaggedWeightLogs,
      missingCheckinClients: missingCheckinRaw,
    };
  }

  // ── Head-coach aggregation: solo context for the head coach's OWN direct
  // clients, plus team-wide business metrics across all sub-coaches + own.
  private async aggregateHeadCoachContext(
    coachId: string,
    ownClientIds: string[],
    timezone: string,
    briefDate: string,
  ): Promise<{
    context: BriefContextHeadCoach;
    pendingWorkouts: Array<{
      id: string;
      client_id: string;
      client_name: string;
      plan_name: string;
    }>;
    unreadThreads: Array<{
      client_id: string;
      client_name: string;
      message_preview: string;
    }>;
    flaggedWeightLogs: Array<{
      client_id: string;
      client_name: string;
      delta_lbs: number;
    }>;
    missingCheckinClients: Array<{ id: string; name: string }>;
  }> {
    // Phase 1 — own client base context (sequential because the team aggregation
    // depends on knowing the head coach's identity, but the solo aggregator already
    // runs its own queries in parallel).
    const soloResult = await this.aggregateSoloContext(
      coachId,
      ownClientIds,
      timezone,
      briefDate,
    );

    // Phase 2 — resolve sub-coaches + their clients
    const subCoaches = await this.prisma.teamSubCoachAssignment.findMany({
      where: { head_coach_id: coachId, archived_at: null },
      select: {
        sub_coach_id: true,
        sub_coach: { select: { id: true, name: true } },
      },
    });
    const allCoachIds = [coachId, ...subCoaches.map((a) => a.sub_coach_id)];

    const allTeamClients = await this.prisma.user.findMany({
      where: {
        coach_id: { in: allCoachIds },
        archived_at: null,
        role: 'student',
      },
      select: { id: true, coach_id: true, created_at: true },
    });

    const briefDateStart = startOfDayInTz(briefDate, timezone);
    const briefDateEnd = endOfDayInTz(briefDate, timezone);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Phase 3 — team aggregates in parallel
    const [
      revenueTodayAgg,
      revenue30dAgg,
      mrrPurchases,
      dunningAmountRaw,
      newClients24h,
    ] = await Promise.all([
      this.prisma.clientPurchase.aggregate({
        _sum: { amount_cents: true },
        where: {
          coach_user_id: { in: allCoachIds },
          status: 'paid',
          updated_at: { gte: briefDateStart, lte: briefDateEnd },
        },
      }),
      this.prisma.clientPurchase.aggregate({
        _sum: { amount_cents: true },
        where: {
          coach_user_id: { in: allCoachIds },
          status: 'paid',
          updated_at: { gte: thirtyDaysAgo },
        },
      }),
      // MRR — fetch recurring purchases with their package interval so we
      // can normalize annual / multi-month plans to a monthly equivalent.
      // Summing amount_cents alone would count annual plans as monthly MRR.
      this.prisma.clientPurchase.findMany({
        where: {
          coach_user_id: { in: allCoachIds },
          status: 'active',
          billing_type: 'recurring',
          entitlement_active: true,
        },
        select: {
          amount_cents: true,
          package: { select: { interval: true, interval_count: true } },
        },
      }),
      this.prisma.$queryRaw<Array<{ total: bigint | null }>>(
        Prisma.sql`
          SELECT COALESCE(SUM(ds."last_failed_amount_cents"), 0)::bigint AS total
          FROM "DunningState" ds
          JOIN "ClientPurchase" cp ON cp."id" = ds."purchase_id"
          WHERE ds."status" = 'active'
            AND cp."coach_user_id" = ANY(${allCoachIds}::text[])
        `,
      ),
      this.prisma.user.count({
        where: {
          coach_id: { in: allCoachIds },
          archived_at: null,
          role: 'student',
          created_at: { gte: twentyFourHoursAgo },
        },
      }),
    ]);

    // Normalize each recurring purchase to its monthly-equivalent cents.
    // year     -> amount / (12 * interval_count)
    // month    -> amount / interval_count
    // null / other -> exclude (treated as non-recurring for MRR purposes)
    const mrrProjectedCents = mrrPurchases.reduce((sum, p) => {
      const interval = p.package?.interval;
      const count = p.package?.interval_count && p.package.interval_count > 0
        ? p.package.interval_count
        : 1;
      if (interval === 'year') {
        return sum + Math.round(p.amount_cents / (12 * count));
      }
      if (interval === 'month') {
        return sum + Math.round(p.amount_cents / count);
      }
      return sum;
    }, 0);

    const subCoachHighlights: SubCoachHighlight[] = subCoaches
      .map((sc) => {
        const sub = sc.sub_coach;
        if (!sub) return null;
        const clientsForSub = allTeamClients.filter(
          (c) => c.coach_id === sub.id,
        );
        return {
          coach_name: sub.name,
          active_clients: clientsForSub.length,
          new_clients_24h: clientsForSub.filter(
            (c) => c.created_at >= twentyFourHoursAgo,
          ).length,
        };
      })
      .filter((s): s is SubCoachHighlight => s !== null)
      .sort((a, b) => b.active_clients - a.active_clients)
      .slice(0, 3);

    const context: BriefContextHeadCoach = {
      ...soloResult.context,
      brief_mode: 'head_coach',
      team_size: subCoaches.length,
      team_clients_total: allTeamClients.length,
      total_revenue_today_cents: revenueTodayAgg._sum.amount_cents ?? 0,
      team_revenue_30d_cents: revenue30dAgg._sum.amount_cents ?? 0,
      mrr_projected_cents: mrrProjectedCents,
      dunning_amount_cents: Number(dunningAmountRaw[0]?.total ?? 0),
      new_clients_last_24h: newClients24h,
      sub_coach_highlights: subCoachHighlights,
    };

    return {
      context,
      pendingWorkouts: soloResult.pendingWorkouts,
      unreadThreads: soloResult.unreadThreads,
      flaggedWeightLogs: soloResult.flaggedWeightLogs,
      missingCheckinClients: soloResult.missingCheckinClients,
    };
  }

  // ── Anthropic call with AbortController + 15s timeout + mode-aware
  // system prompt. NEVER throws — Claude failures fall back to a
  // deterministic narrative.
  async callClaude(
    ctx: BriefContext | BriefContextHeadCoach,
  ): Promise<{ narrative: string; generated_by: 'ai' | 'fallback' }> {
    const actionCount =
      ctx.workouts_pending_approval +
      (ctx.missed_checkin > 0 ? 1 : 0) +
      ctx.weight_logs_flagged +
      ctx.unread_messages;

    // Fast-path fallback for zero-action briefs — no Claude call needed.
    if (actionCount === 0 && ctx.checked_in_today > 0) {
      return {
        narrative: buildFallbackNarrative(ctx),
        generated_by: 'fallback',
      };
    }

    let client: Anthropic;
    try {
      client = this.getAnthropicClient();
    } catch (err) {
      // ANTHROPIC_API_KEY missing — never propagate as 500 to coach.
      this.logger.error(
        `CoachBrief Anthropic client init failed: ${errorMessageOf(err)}`,
      );
      return {
        narrative: buildFallbackNarrative(ctx),
        generated_by: 'fallback',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      BRIEF_ANTHROPIC_TIMEOUT_MS,
    );

    const systemPrompt =
      ctx.brief_mode === 'head_coach'
        ? buildHeadCoachSystemPrompt()
        : buildSoloCoachSystemPrompt();
    const userPrompt = buildBriefPrompt(ctx);

    try {
      const resp = await client.messages.create(
        {
          model: BRIEF_CLAUDE_MODEL,
          max_tokens: BRIEF_MAX_TOKENS,
          temperature: BRIEF_TEMPERATURE,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        },
        { signal: controller.signal },
      );

      const block = resp.content?.find((b) => b.type === 'text');
      const text = block && block.type === 'text' ? block.text.trim() : '';

      if (!text) throw new Error('Empty Claude response');

      const clamped =
        text.length > BRIEF_MAX_NARRATIVE_CHARS
          ? text.slice(0, BRIEF_MAX_NARRATIVE_CHARS)
          : text;
      return { narrative: clamped, generated_by: 'ai' };
    } catch (err) {
      this.logger.error(
        `CoachBrief Claude call failed for coach=${ctx.coach_name}: ${errorMessageOf(err)}`,
      );
      return {
        narrative: buildFallbackNarrative(ctx),
        generated_by: 'fallback',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Orchestrator. Idempotent AND race-safe.
  //
  // Two callers hitting GET /brief/today for the same coach + date must
  // NOT both call Claude. The previous version did a read, then an
  // unconditional upsert resetting status to 'pending' — that races on
  // concurrent calls and produces two outbound AI calls + two updates
  // overwriting each other.
  //
  // The fix is a single atomic claim:
  //   * Normal path  — upsert with create={status:'generating'}, update={}
  //     (no-op). The caller that CREATED the row sees status='generating'
  //     and is the unique winner; any other caller sees an existing row
  //     and returns it (cached if generated, or the in-progress claim row
  //     so the client can poll).
  //   * Force path   — updateMany WHERE status != 'generating' SET status
  //     = 'generating'. Exactly one regenerate can claim; others see the
  //     row and return.
  async generateBrief(
    coachId: string,
    timezone: string,
    briefDate: string,
    opts: { force?: boolean } = {},
  ): Promise<CoachBriefResponse> {
    if (opts.force) {
      // Atomic claim for forced regeneration: flip the row to
      // 'generating' only if no other caller has it locked.
      const claim = await this.prisma.coachBrief.updateMany({
        where: {
          coach_id: coachId,
          brief_date: briefDate,
          status: { not: 'generating' },
        },
        data: { status: 'generating', generated_at: null },
      });

      if (claim.count === 0) {
        // Either no row yet, or another regenerate is in flight. Try to
        // create the row (status='generating') — if that loses the race
        // it means a concurrent regenerate already claimed; return that.
        try {
          await this.prisma.coachBrief.create({
            data: {
              coach_id: coachId,
              brief_date: briefDate,
              status: 'generating',
            },
          });
        } catch (err) {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          ) {
            const inflight = await this.prisma.coachBrief.findUnique({
              where: {
                CoachBrief_coach_date_key: {
                  coach_id: coachId,
                  brief_date: briefDate,
                },
              },
            });
            if (inflight) return this.toResponse(inflight);
          }
          throw err;
        }
      }
    } else {
      // Normal idempotent path. Cache hit short-circuits before any
      // Claude work; the claim upsert lets exactly one caller proceed.
      const existing = await this.prisma.coachBrief.findUnique({
        where: {
          CoachBrief_coach_date_key: {
            coach_id: coachId,
            brief_date: briefDate,
          },
        },
      });
      if (existing && existing.status === 'generated') {
        return this.toResponse(existing);
      }
      if (existing && existing.status === 'generating') {
        // Another worker is generating this row right now. Return it as
        // pending so the client polls instead of triggering a second
        // Claude call.
        return this.toResponse(existing);
      }

      try {
        const created = await this.prisma.coachBrief.create({
          data: {
            coach_id: coachId,
            brief_date: briefDate,
            status: 'generating',
          },
        });
        // Sanity — we own the claim only because create succeeded.
        void created;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          // Lost the create race: another caller is generating (or just
          // finished). Return whatever's there — generated rows return
          // the cached narrative, generating rows tell the client to
          // poll.
          const winner = await this.prisma.coachBrief.findUnique({
            where: {
              CoachBrief_coach_date_key: {
                coach_id: coachId,
                brief_date: briefDate,
              },
            },
          });
          if (winner) return this.toResponse(winner);
        }
        throw err;
      }
    }

    // From here on we OWN the generating-row. Do the work and finalize.
    try {
      const briefMode = await this.detectBriefMode(coachId);
      const clientIds = await this.resolveClientScope(coachId, briefMode);

      const agg =
        briefMode === 'head_coach'
          ? await this.aggregateHeadCoachContext(
              coachId,
              clientIds,
              timezone,
              briefDate,
            )
          : await this.aggregateSoloContext(
              coachId,
              clientIds,
              timezone,
              briefDate,
              briefMode,
            );

      // Solo aggregator always returns brief_mode='solo_coach' — adjust
      // for sub_coach.
      if (briefMode === 'sub_coach') {
        agg.context.brief_mode = 'sub_coach';
      }

      const actionItems = buildActionItems({
        pendingWorkouts: agg.pendingWorkouts,
        unreadThreads: agg.unreadThreads,
        flaggedWeightLogs: agg.flaggedWeightLogs,
        missingCheckinClients: agg.missingCheckinClients,
      });

      const { narrative, generated_by } = await this.callClaude(agg.context);

      const updated = await this.prisma.coachBrief.update({
        where: {
          CoachBrief_coach_date_key: {
            coach_id: coachId,
            brief_date: briefDate,
          },
        },
        data: {
          status: 'generated',
          generated_at: new Date(),
          narrative,
          brief_context: agg.context as unknown as Prisma.JsonObject,
          action_items: actionItems as unknown as Prisma.JsonArray,
          generated_by,
          brief_mode: briefMode,
        },
      });

      return this.toResponse(updated);
    } catch (err) {
      // Release the claim so the next request can retry. We do not
      // distinguish failures here — the next caller will re-claim.
      this.logger.error(
        `CoachBrief generation failed for coach=${coachId}: ${errorMessageOf(err)}`,
      );
      await this.prisma.coachBrief
        .updateMany({
          where: {
            coach_id: coachId,
            brief_date: briefDate,
            status: 'generating',
          },
          data: { status: 'failed' },
        })
        .catch(() => undefined);
      throw err;
    }
  }

  // ── HTTP handler entry point. Defaults to today's brief in the coach's
  // local timezone.
  async getOrGenerateTodaysBrief(coachId: string): Promise<CoachBriefResponse> {
    const timezone = await this.resolveCoachTimezone(coachId);
    const briefDate = bucketDateLocal(new Date(), timezone);
    return this.generateBrief(coachId, timezone, briefDate);
  }

  // ── History list. 30-day window, paginated.
  async getBriefHistory(
    coachId: string,
    page: number,
    limit: number,
  ): Promise<{
    items: CoachBriefResponse[];
    total: number;
    page: number;
    limit: number;
  }> {
    const timezone = await this.resolveCoachTimezone(coachId);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const cutoff = bucketDateLocal(thirtyDaysAgo, timezone);

    const where: Prisma.CoachBriefWhereInput = {
      coach_id: coachId,
      status: 'generated',
      brief_date: { gte: cutoff },
    };

    const [total, rows] = await Promise.all([
      this.prisma.coachBrief.count({ where }),
      this.prisma.coachBrief.findMany({
        where,
        orderBy: { brief_date: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items: rows.map((r) => this.toResponse(r)),
      total,
      page,
      limit,
    };
  }

  // ── Force regenerate (POST /regenerate, throttled at the controller).
  async regenerateTodaysBrief(coachId: string): Promise<CoachBriefResponse> {
    const timezone = await this.resolveCoachTimezone(coachId);
    const briefDate = bucketDateLocal(new Date(), timezone);
    return this.generateBrief(coachId, timezone, briefDate, { force: true });
  }

  // ── Map Prisma row → HTTP response shape.
  private toResponse(row: {
    id: string;
    coach_id: string;
    brief_date: string;
    status: string;
    generated_at: Date | null;
    narrative: string | null;
    brief_context: Prisma.JsonValue | null;
    action_items: Prisma.JsonValue | null;
    generated_by: string | null;
    brief_mode: string | null;
    created_at: Date;
  }): CoachBriefResponse {
    const status =
      row.status === 'generated' || row.status === 'failed' ? row.status : 'pending';
    const briefMode =
      row.brief_mode === 'solo_coach' ||
      row.brief_mode === 'head_coach' ||
      row.brief_mode === 'sub_coach'
        ? row.brief_mode
        : null;

    let summary: BriefSummary | null = null;
    if (
      status === 'generated' &&
      row.narrative &&
      row.brief_context &&
      row.action_items &&
      briefMode
    ) {
      const generatedBy =
        row.generated_by === 'ai' ? 'ai' : 'fallback';
      summary = {
        date: row.brief_date,
        brief_mode: briefMode,
        narrative: row.narrative,
        brief_context: row.brief_context as unknown as
          | BriefContext
          | BriefContextHeadCoach,
        action_items: row.action_items as unknown as ActionItem[],
        generated_by: generatedBy,
      };
    }

    return {
      id: row.id,
      coach_id: row.coach_id,
      brief_date: row.brief_date,
      status,
      brief_mode: briefMode,
      generated_at: row.generated_at ? row.generated_at.toISOString() : null,
      summary,
      created_at: row.created_at.toISOString(),
    };
  }
}

// ─── Small helpers ──────────────────────────────────────────────────────

// Return the UTC instant at midnight on a YYYY-MM-DD date in a given IANA
// timezone. Used to scope updated_at filters to "the coach's brief_date in
// their local tz", which is what mobile + the prompt mean by "today".
function startOfDayInTz(briefDate: string, timeZone: string): Date {
  const [y, m, d] = briefDate.split('-').map(Number);
  // We do not have access to a tz library here; the cheapest approximation
  // that works correctly under DST is to construct the date in UTC and let
  // Postgres handle the comparison. For Postgres timestamp comparison this
  // is conservative — slightly wider window in one direction does NOT
  // overcount paid_today because ClientPurchase rows only update once.
  const utc = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  return shiftDateToTzMidnight(utc, timeZone);
}

function endOfDayInTz(briefDate: string, timeZone: string): Date {
  const start = startOfDayInTz(briefDate, timeZone);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}

// Given a Date that represents "midnight UTC on YYYY-MM-DD", return the
// Date that represents midnight on YYYY-MM-DD in the given IANA tz.
// We compute the tz offset via Intl.DateTimeFormat with a known UTC anchor,
// then subtract that offset.
function shiftDateToTzMidnight(utcMidnight: Date, timeZone: string): Date {
  // Format the UTC midnight in the target tz; the result tells us what
  // wall-clock that instant represents. Working backward, the tz midnight
  // corresponds to UTC midnight + offset.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(utcMidnight);
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0';
  let hourInTz = parseInt(hourStr, 10);
  if (hourInTz === 24) hourInTz = 0;
  // If the tz wall-clock hour at this UTC instant is H, the offset (UTC -
  // tz) is H hours (mod 24, treating values > 12 as negative for western
  // hemisphere). We treat 0..12 as a positive UTC-tz offset (eastern), and
  // 13..23 as -(24-H) (western).
  const offsetHours = hourInTz <= 12 ? hourInTz : hourInTz - 24;
  return new Date(utcMidnight.getTime() - offsetHours * 60 * 60 * 1000);
}
