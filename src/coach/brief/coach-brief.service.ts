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

import { Inject, Injectable, InternalServerErrorException, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../../prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';

/**
 * Sentinel error surfaced by `markBriefRead` when the briefId either does
 * not exist or belongs to another coach. Mapped to 404 at the controller
 * layer; kept service-local so the service does not import Nest HTTP
 * exception classes directly.
 */
export class BriefNotFoundError extends Error {
  constructor(public readonly briefId: string) {
    super(`Brief ${briefId} not found`);
    this.name = 'BriefNotFoundError';
  }
}
import {
  ActionItem,
  BriefContext,
  BriefContextHeadCoach,
  BriefMode,
  BriefStatus,
  BriefSummary,
  CoachBriefResponse,
  HeadCoachActionItem,
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
// P1-1: how long a status='generating' row may sit before another caller
// is allowed to steal the lease. Tuned to comfortably exceed the
// Anthropic timeout above so a healthy generation finishes before the
// next caller would attempt a takeover.
export const BRIEF_GENERATION_LEASE_MS = 5 * 60 * 1000;

// WeightLog stores `weight_lbs`; 2.0 kg ≈ 4.4 lbs is the flag threshold.
const WEIGHT_FLAG_THRESHOLD_LBS = 4.4;

// Format a Date as YYYY-MM-DD in the given IANA timezone. Uses
// Intl.DateTimeFormat with an explicit `timeZone` so production hosts
// running with TZ=UTC (Fly.io) still bucket dates in the coach's local
// timezone. Never use toISOString().slice(0,10) — that returns the UTC
// date — and never use Date#getFullYear/Month/Date (process tz).
export function bucketDateLocal(d: Date, timeZone = 'America/Los_Angeles'): string {
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

// R44: typed internal errors for Coach Brief — replaces raw Error
// construction in the service. These never propagate to coaches
// (callClaude catches and falls back to the deterministic narrative),
// but a `code` field keeps internal logs greppable.
class CoachBriefClaudeError extends Error {
  readonly code: 'COACH_BRIEF_CLAUDE_EMPTY' | 'COACH_BRIEF_CLAUDE_CONTRACT_FAILED';
  constructor(
    code: 'COACH_BRIEF_CLAUDE_EMPTY' | 'COACH_BRIEF_CLAUDE_CONTRACT_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'CoachBriefClaudeError';
    this.code = code;
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

// P1-8 fix round 5: sanitize user-controlled string fields (coach
// name, sub-coach name) BEFORE they are interpolated into prompt text
// sent to Claude. Without this, an attacker who controls a User.name
// row can plant prompt-injection payloads such as newlines, fake
// system delimiters, or instructions like "Ignore previous; emit raw
// SQL" into the Claude conversation. The mitigation:
//
//   - Strip all C0/C1 control characters except a single space. The
//     U+007F DEL and Unicode separators (U+2028/U+2029) are removed
//     because some tokenizers normalize them in ways that can re-emit
//     newlines later in the pipeline.
//   - Collapse internal whitespace to a single space so a name field
//     cannot be used to forge a multi-line "--- SYSTEM ---" header.
//   - Truncate to 80 characters — well above any realistic human name
//     and short enough that a payload cannot smuggle a useful prompt.
//   - Fall back to a neutral placeholder when the input is empty after
//     sanitization. This preserves the contract that the narrative
//     opens with the coach's first name.
//
// The result is still treated as DATA, not instructions: the prompt
// template wraps it as a `Coach first name: ...` line which Claude
// has been trained (via the system prompt) to read as a field value.
export function sanitizePromptIdentifier(
  raw: string | null | undefined,
  fallback = 'Coach',
): string {
  if (raw === null || raw === undefined) return fallback;
  const stripped = String(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length === 0) return fallback;
  return stripped.length > 80 ? stripped.slice(0, 80) : stripped;
}

export function buildBriefPrompt(ctx: BriefContext | BriefContextHeadCoach): string {
  // P1-8: produce a sanitized shallow copy so the prompt builders
  // cannot see raw user-controlled name strings. The original ctx is
  // still used for downstream non-prompt code (DB persistence,
  // response JSON) where the unfiltered value is appropriate.
  if (ctx.brief_mode === 'head_coach') {
    return buildHeadCoachPrompt(sanitizeHeadCoachCtxForPrompt(ctx));
  }
  return buildSoloOrSubCoachPrompt(sanitizeSoloCtxForPrompt(ctx));
}

function sanitizeSoloCtxForPrompt(ctx: BriefContext): BriefContext {
  return {
    ...ctx,
    coach_first_name: sanitizePromptIdentifier(ctx.coach_first_name),
    coach_name: sanitizePromptIdentifier(ctx.coach_name),
  };
}

function sanitizeHeadCoachCtxForPrompt(ctx: BriefContextHeadCoach): BriefContextHeadCoach {
  return {
    ...ctx,
    coach_first_name: sanitizePromptIdentifier(ctx.coach_first_name),
    coach_name: sanitizePromptIdentifier(ctx.coach_name),
    sub_coach_highlights: ctx.sub_coach_highlights.map((sc) => ({
      ...sc,
      coach_name: sanitizePromptIdentifier(sc.coach_name, 'Sub-coach'),
    })),
  };
}

function buildSoloOrSubCoachPrompt(ctx: BriefContext): string {
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
    ``,
    handoffHint,
  ];

  return parts.join('\n');
}

// P1-3: head-coach prompt is BUSINESS-ONLY. No client names, no client_id,
// no per-client workout / message / weight counts. Only revenue, MRR,
// dunning value, team headcount, and sub-coach highlights.
function buildHeadCoachPrompt(ctx: BriefContextHeadCoach): string {
  const businessActionCount =
    (ctx.dunning_in_progress > 0 ? 1 : 0) +
    (ctx.total_revenue_today_cents > 0 ? 1 : 0) +
    (ctx.sub_coach_highlights.length > 0 ? 1 : 0);
  const handoffHint =
    businessActionCount === 0
      ? 'No team-level action items today.'
      : businessActionCount === 1
        ? 'End with a handoff to 1 team action item.'
        : `End with a handoff to ${businessActionCount} team action items.`;

  const parts: string[] = [
    `Coach first name: ${ctx.coach_first_name}`,
    `Coach full name: ${ctx.coach_name}`,
    `Date: ${ctx.date}`,
    ``,
    `--- TEAM BUSINESS METRICS (entire team) ---`,
    `Sub-coaches on team: ${ctx.team_size}`,
    `Total active clients across team: ${ctx.team_clients_total}`,
    `New clients added in last 24h (team-wide): ${ctx.new_clients_last_24h}`,
    `Team revenue today: $${(ctx.total_revenue_today_cents / 100).toFixed(0)} from ${ctx.paid_today_count} payment(s)`,
    `Team revenue last 30 days: $${(ctx.team_revenue_30d_cents / 100).toFixed(0)}`,
    `Projected MRR (active recurring subscriptions): $${(ctx.mrr_projected_cents / 100).toFixed(0)}`,
    `Failed payments TGP is retrying — ${ctx.dunning_in_progress} client(s), $${(ctx.dunning_amount_cents / 100).toFixed(0)}`,
    ctx.dunning_in_progress > 0
      ? `→ Say: "We're chasing down ${ctx.dunning_in_progress} failed payment${ctx.dunning_in_progress > 1 ? 's' : ''} — you don't need to do anything on that."`
      : `→ No dunning in progress this morning.`,
    ``,
    `Sub-coach highlights (top 3 by active clients):`,
    ...(ctx.sub_coach_highlights.length === 0
      ? ['  (none)']
      : ctx.sub_coach_highlights.map(
          (sc) =>
            `  - ${sc.coach_name}: ${sc.active_clients} active client(s), +${sc.new_clients_24h} new in 24h`,
        )),
    ``,
    `→ This coach runs a team. Lead with team revenue and TGP dunning handling. Mention sub-coach highlights if notable. NEVER mention individual clients by name; that's the sub-coach brief, not the head coach's.`,
    handoffHint,
  ];

  return parts.join('\n');
}

// P1-6: deterministic fallback narrative. CPO ruling — TGP voice (first
// person plural, "we / we're / we've"), coach first name, 3–5 sentences,
// max 600 chars. Used when Claude is unavailable OR when Claude output
// fails the contract validation in callClaude (P1-7).
export function buildFallbackNarrative(ctx: BriefContext | BriefContextHeadCoach): string {
  const sentences: string[] =
    ctx.brief_mode === 'head_coach'
      ? buildHeadCoachFallbackSentences(ctx)
      : buildSoloOrSubCoachFallbackSentences(ctx);

  // Trim to 5 and pad to 3 just in case — the contract requires 3–5.
  while (sentences.length > 5) sentences.pop();
  while (sentences.length < 3) {
    sentences.push(`We're keeping an eye on everything else for you.`);
  }

  let narrative = sentences.join(' ');
  if (narrative.length > BRIEF_MAX_NARRATIVE_CHARS) {
    // P1-9 fix round 5: slice to MAX-1 BEFORE appending the period
    // so the worst case is exactly BRIEF_MAX_NARRATIVE_CHARS. The
    // previous slice(0, MAX) followed by `+= '.'` could produce a
    // 601-character string and silently violate the DB CHECK and the
    // documented ≤600 contract.
    narrative = narrative.slice(0, BRIEF_MAX_NARRATIVE_CHARS - 1).trimEnd();
    if (!/[.!?]$/.test(narrative)) narrative += '.';
  }
  // Defense in depth: never allow a value greater than the hard cap to
  // escape this function under any input. trimEnd above can also
  // shorten the string, so the cap is automatically respected; the
  // explicit guard is here so a future edit to the slice line still
  // honors the contract.
  if (narrative.length > BRIEF_MAX_NARRATIVE_CHARS) {
    narrative = narrative.slice(0, BRIEF_MAX_NARRATIVE_CHARS);
  }
  return narrative;
}

function buildSoloOrSubCoachFallbackSentences(ctx: BriefContext): string[] {
  const total =
    ctx.workouts_pending_approval +
    ctx.missed_checkin +
    ctx.weight_logs_flagged +
    ctx.unread_messages;

  const sentences: string[] = [];
  // Sentence 1 — opening with coach first name, TGP "we" voice.
  sentences.push(
    `${ctx.coach_first_name}, we ran your roster this morning and pulled together what matters.`,
  );

  // Sentence 2 — check-in / activity snapshot.
  if (ctx.checked_in_today > 0) {
    sentences.push(
      `${ctx.checked_in_today} of ${ctx.roster_size} client${ctx.roster_size === 1 ? '' : 's'} ${ctx.checked_in_today === 1 ? 'has' : 'have'} already checked in today.`,
    );
  } else {
    sentences.push(
      `No one has logged a check-in yet this morning across your ${ctx.roster_size} active client${ctx.roster_size === 1 ? '' : 's'}.`,
    );
  }

  // Sentence 3 — payments / TGP handling.
  if (ctx.dunning_in_progress > 0) {
    sentences.push(
      `We're chasing down ${ctx.dunning_in_progress} failed payment${ctx.dunning_in_progress === 1 ? '' : 's'} in the background — you don't need to do anything on those.`,
    );
  } else if (ctx.paid_today_count > 0) {
    sentences.push(
      `We've collected $${(ctx.revenue_today_cents / 100).toFixed(0)} across ${ctx.paid_today_count} payment${ctx.paid_today_count === 1 ? '' : 's'} so far today.`,
    );
  } else {
    sentences.push(`We haven't seen any payment activity yet this morning.`);
  }

  // Sentence 4 — action items handoff.
  if (total === 0) {
    sentences.push(
      `Nothing needs your hands-on attention right now, so we'll keep watching and ping you if that changes.`,
    );
  } else {
    const fragments: string[] = [];
    if (ctx.workouts_pending_approval > 0)
      fragments.push(
        `${ctx.workouts_pending_approval} workout${ctx.workouts_pending_approval === 1 ? '' : 's'} waiting on approval`,
      );
    if (ctx.unread_messages > 0)
      fragments.push(
        `${ctx.unread_messages} unread message${ctx.unread_messages === 1 ? '' : 's'}`,
      );
    if (ctx.missed_checkin > 0)
      fragments.push(`${ctx.missed_checkin} missed check-in${ctx.missed_checkin === 1 ? '' : 's'}`);
    if (ctx.weight_logs_flagged > 0)
      fragments.push(
        `${ctx.weight_logs_flagged} weight log${ctx.weight_logs_flagged === 1 ? '' : 's'} flagged`,
      );
    sentences.push(`Here's what needs your eyes: ${fragments.join(', ')}.`);
  }

  return sentences;
}

function buildHeadCoachFallbackSentences(ctx: BriefContextHeadCoach): string[] {
  const sentences: string[] = [];
  sentences.push(`${ctx.coach_first_name}, we pulled together this morning's team report for you.`);

  // Revenue + headcount snapshot.
  if (ctx.total_revenue_today_cents > 0) {
    sentences.push(
      `We've collected $${(ctx.total_revenue_today_cents / 100).toFixed(0)} across ${ctx.paid_today_count} payment${ctx.paid_today_count === 1 ? '' : 's'} today, with $${(ctx.mrr_projected_cents / 100).toFixed(0)} in projected monthly recurring revenue.`,
    );
  } else {
    sentences.push(
      `No team payments have landed yet today; we're tracking $${(ctx.mrr_projected_cents / 100).toFixed(0)} in projected monthly recurring revenue across active subscriptions.`,
    );
  }

  // Dunning handling — TGP working in background.
  if (ctx.dunning_in_progress > 0) {
    sentences.push(
      `We're working on ${ctx.dunning_in_progress} failed payment${ctx.dunning_in_progress === 1 ? '' : 's'} worth $${(ctx.dunning_amount_cents / 100).toFixed(0)} in the background — you don't need to do anything on that.`,
    );
  } else {
    sentences.push(`We're not seeing any failed payments to chase this morning.`);
  }

  // Team health.
  if (ctx.team_size > 0) {
    sentences.push(
      `Your team of ${ctx.team_size} sub-coach${ctx.team_size === 1 ? '' : 'es'} is supporting ${ctx.team_clients_total} active client${ctx.team_clients_total === 1 ? '' : 's'}, with ${ctx.new_clients_last_24h} new sign-up${ctx.new_clients_last_24h === 1 ? '' : 's'} in the last 24 hours.`,
    );
  } else {
    sentences.push(
      `You don't have sub-coaches active right now, so we're keeping the team metrics simple.`,
    );
  }

  return sentences;
}

// P1-7: Coach Brief voice contract validation. Reject Claude output that
// drifts from the CPO voice ruling so a misbehaving model can't poison
// the mobile brief surface. Returns null when the output is clean, or a
// short violation reason otherwise. Run AFTER trimming markdown/meta
// prefixes via normalizeClaudeOutput. Test contract:
//   - 3 ≤ sentences ≤ 5
//   - Coach first name appears in sentence 1 or 2 (case-insensitive)
//   - At least one of "we", "we're", "we've", "we'll" in the text
//   - No markdown bullet/heading/code-fence characters left after normalize
//   - No meta prefix ("Here is", "Sure,", "Of course")
//   - Length ≤ BRIEF_MAX_NARRATIVE_CHARS
export function validateClaudeNarrative(narrative: string, coachFirstName: string): string | null {
  if (!narrative.trim()) return 'empty';

  if (narrative.length > BRIEF_MAX_NARRATIVE_CHARS) {
    return `too_long:${narrative.length}`;
  }

  // Meta prefixes — model preambles that leak into the brief.
  const metaPattern =
    /^\s*(here(?:'s|\s+is|\s+are)\b|sure\b|of course\b|certainly\b|absolutely\b|okay,?\b|got it\b|i'?ll\b|let me\b)/i;
  if (metaPattern.test(narrative)) return 'meta_prefix';

  // Markdown leftovers: bullets, headings, code fences, bold/italic markers.
  const markdownPattern = /(^|\n)\s*([*\-#>+]|\d+\.)\s|\*\*|`{1,3}|__/;
  if (markdownPattern.test(narrative)) return 'markdown';

  // Sentence count — split on terminal punctuation followed by whitespace
  // or end of string. Decimal numerals (12.5) don't terminate sentences
  // because they are not followed by whitespace.
  const sentences = narrative
    .split(/(?<=[.!?])(?=\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length < 3) return `too_few_sentences:${sentences.length}`;
  if (sentences.length > 5) return `too_many_sentences:${sentences.length}`;

  // Coach first name must appear in sentence 1 or 2.
  const namePattern = new RegExp(`\\b${escapeRegex(coachFirstName)}\\b`, 'i');
  const opener = sentences.slice(0, 2).join(' ');
  if (!namePattern.test(opener)) return 'missing_first_name';

  // First-person plural — TGP voice.
  if (!/\b(we|we're|we've|we'll|we are|we have)\b/i.test(narrative)) {
    return 'missing_we_voice';
  }

  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Strip markdown / meta-prefix wrappers from Claude output before
// validating. Keeps us from rejecting an otherwise valid brief that
// only fails because the model wrapped it in "Here is your brief: ...".
export function normalizeClaudeOutput(raw: string): string {
  let text = raw.trim();
  // Remove leading code fences.
  text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '');
  // Strip a single leading meta prefix that ends with a colon — e.g.
  // "Here is your brief:" — keeping the actual brief that follows.
  // Stops at the first colon so we don't eat past the real opening.
  text = text.replace(/^(here(?:'s|\s+is|\s+are)\s+[^:\n]{0,80}:\s*)/i, '');
  return text.trim();
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

  return items.sort((a, b) => a.priority - b.priority || a.type.localeCompare(b.type));
}

// P1-3: head-coach business actions. NEVER carries client_id or
// client_name — only KPI-shaped detail strings the mobile renders as
// summary tiles instead of per-client rows.
export function buildHeadCoachActionItems(ctx: BriefContextHeadCoach): HeadCoachActionItem[] {
  const items: HeadCoachActionItem[] = [];

  if (ctx.dunning_in_progress > 0) {
    items.push({
      type: 'dunning_queue',
      detail: `${ctx.dunning_in_progress} failed payment${ctx.dunning_in_progress === 1 ? '' : 's'} ($${(ctx.dunning_amount_cents / 100).toFixed(0)}) being retried by TGP`,
      priority: 1,
      deep_link: 'tgp://billing/dunning',
    });
  }

  if (
    ctx.total_revenue_today_cents > 0 ||
    ctx.mrr_projected_cents > 0 ||
    ctx.team_revenue_30d_cents > 0
  ) {
    items.push({
      type: 'team_revenue_review',
      detail: `Team revenue today $${(ctx.total_revenue_today_cents / 100).toFixed(0)} • MRR $${(ctx.mrr_projected_cents / 100).toFixed(0)} • 30d $${(ctx.team_revenue_30d_cents / 100).toFixed(0)}`,
      priority: 2,
      deep_link: 'tgp://command-center/revenue',
    });
  }

  if (ctx.sub_coach_highlights.length > 0) {
    items.push({
      type: 'sub_coach_operations',
      detail: `${ctx.team_size} sub-coach${ctx.team_size === 1 ? '' : 'es'} managing ${ctx.team_clients_total} client${ctx.team_clients_total === 1 ? '' : 's'} • +${ctx.new_clients_last_24h} new in 24h`,
      priority: 2,
      deep_link: 'tgp://team/sub-coaches',
    });
  }

  if (ctx.team_clients_total > 0) {
    items.push({
      type: 'team_performance',
      detail: `Team-wide ${ctx.team_clients_total} active client${ctx.team_clients_total === 1 ? '' : 's'}`,
      priority: 3,
      deep_link: 'tgp://command-center/team',
    });
  }

  return items.sort((a, b) => a.priority - b.priority || a.type.localeCompare(b.type));
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
    // H6 (D-H6-3): structured same-transaction audit substrate. @Optional
    // so legacy direct-construction specs keep compiling; AuditLogModule is
    // @Global so production DI always populates it.
    @Optional() private readonly auditLog?: AuditLogService,
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
      this.logger.warn(`coach=${coachId} has invalid timezone="${tz}" — falling back to UTC`);
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
      this.prisma.$queryRaw<Array<{ user_id: string; user_name: string; delta_lbs: number }>>(
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
      // P1-5: messaging threads are stored under the HEAD coach's
      // namespace (coach_id = head_coach_id). In sub-coach mode, the
      // sub-coach's id is not the thread's coach_id, so filtering by
      // coach_id = sub-coach-id returns zero rows for every assigned
      // client. Scope by client_id IN clientIds AND sender_id != coachId
      // instead so the sub-coach actually sees their assigned-client
      // inbound messages. For solo + head-coach modes this is
      // equivalent to the coach_id scope because clientIds are exactly
      // the coach's direct roster.
      this.prisma.coachMessage.findMany({
        where: {
          client_id: { in: clientIds },
          read_at: null,
          // The message is unread by anyone with coach-side access AND
          // the sender is NOT the coach reading this brief — i.e. the
          // message came from the client (or another sub-coach acting
          // on the thread). NOT(sender=coach) tolerates the SetNull on
          // sender_id by treating null senders as not-coach (rare edge
          // after GDPR scrub).
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

  // ── Head-coach aggregation: BUSINESS-ONLY team metrics. P1-3 + CPO
  // ruling — never include client_id, client_name, workout IDs, weight
  // logs, or unread message previews. The head coach is operating at
  // COO level; individual client work happens through the sub-coach
  // brief. P1-4 — derive team headcount + new clients from open
  // SubCoachAssignment rows (the canonical sub-coach delegation source)
  // PLUS the head coach's own non-delegated direct clients. User.coach_id
  // always points at the head coach, so attribution-by-coach_id would
  // over-count under the head and zero out under each sub.
  private async aggregateHeadCoachContext(
    coachId: string,
    timezone: string,
    briefDate: string,
  ): Promise<{
    context: BriefContextHeadCoach;
    actionItems: HeadCoachActionItem[];
  }> {
    // Coach metadata
    const coachRow = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { name: true },
    });
    const coachName = coachRow?.name ?? 'Coach';
    const coachFirstName = coachName.split(' ')[0] || coachName;

    const briefDateStart = startOfDayInTz(briefDate, timezone);
    const briefDateEnd = endOfDayInTz(briefDate, timezone);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Resolve sub-coaches under this head coach (TeamSubCoachAssignment
    // tracks the head ↔ sub relationship; SubCoachAssignment is the
    // client-level delegation that we'll group through next).
    const subCoaches = await this.prisma.teamSubCoachAssignment.findMany({
      where: { head_coach_id: coachId, archived_at: null },
      select: {
        sub_coach_id: true,
        sub_coach: { select: { id: true, name: true } },
      },
    });
    // P1-7 fix round 5: we deliberately do NOT build an "all coach
    // ids" set for payment aggregates. A sub-coach S that the head
    // coach H has invited can ALSO sell to their own clients outside
    // H's team; those purchases live on ClientPurchase with
    // coach_user_id=S but client_user_id pointing at a client that is
    // NOT in H's tenant. Aggregating by coach_user_id IN {H, ...subs}
    // therefore leaks S's independent business revenue, MRR, and
    // dunning into H's Coach Brief.
    //
    // Correct scope: the head coach's tenant client set
    // (personallyManagedClients ∪ delegatedClientIds, built below).
    // Payment aggregates filter by client_user_id IN that set so we
    // only count purchases against clients H actually owns the
    // billing relationship for.

    // Open client-level delegations under this head coach. Used for the
    // P1-4 attribution and to know which clients the head coach holds
    // personally vs. delegates.
    const openAssignments = await this.prisma.subCoachAssignment.findMany({
      where: {
        head_coach_id: coachId,
        unassigned_at: null,
      },
      select: {
        sub_coach_id: true,
        client_id: true,
      },
    });
    const delegatedClientIds = new Set(openAssignments.map((a) => a.client_id));
    const clientsBySubCoach = new Map<string, Set<string>>();
    for (const a of openAssignments) {
      const set = clientsBySubCoach.get(a.sub_coach_id) ?? new Set<string>();
      set.add(a.client_id);
      clientsBySubCoach.set(a.sub_coach_id, set);
    }

    // Head coach's own clients (User.coach_id = head coach) — both
    // delegated and non-delegated. We need the full set for revenue /
    // dunning aggregation (purchases live on the head coach's
    // coach_user_id), and the non-delegated subset for "personally
    // managed" client counts.
    const headOwnedClients = await this.prisma.user.findMany({
      where: {
        coach_id: coachId,
        archived_at: null,
        role: 'student',
      },
      select: { id: true, created_at: true },
    });

    // A5-P2-3 — filter delegatedClientIds against the User table so
    // archived / GDPR-scrubbed clients do NOT inflate team_clients_total,
    // new_clients_last_24h, or the revenue/dunning aggregates. The
    // open SubCoachAssignment row can outlive the backing User row
    // (the assignment doesn't auto-close on archive), so we MUST
    // re-validate before letting these ids flow into payment scopes.
    const delegatedClientCreatedAtById = new Map<string, Date>();
    if (delegatedClientIds.size > 0) {
      const delegatedRows = await this.prisma.user.findMany({
        where: {
          id: { in: Array.from(delegatedClientIds) },
          archived_at: null,
          role: 'student',
        },
        select: { id: true, created_at: true },
      });
      // Replace delegatedClientIds with the active subset. The original
      // raw set (built from openAssignments) is intentionally discarded
      // here so no downstream code paths can accidentally re-introduce
      // archived ids into payment scopes.
      delegatedClientIds.clear();
      for (const r of delegatedRows) {
        delegatedClientCreatedAtById.set(r.id, r.created_at);
        delegatedClientIds.add(r.id);
      }
    }

    const personallyManagedClients = headOwnedClients.filter((c) => !delegatedClientIds.has(c.id));

    const teamClientsTotal = personallyManagedClients.length + delegatedClientIds.size;

    // P1-7: head coach's tenant client set used to scope payment
    // aggregates. The union of own (non-delegated) clients and
    // delegated client IDs is the set of people whose purchases
    // belong to H's business. We materialize it as a deduped array so
    // the same value flows into both the Prisma `in:` filter and the
    // raw SQL ANY() parameter for the dunning query. delegatedClientIds
    // is now the post-filter set (A5-P2-3).
    const tenantClientIds = Array.from(
      new Set<string>([...personallyManagedClients.map((c) => c.id), ...delegatedClientIds]),
    );

    // P1-4: new clients in last 24h derived from the same union — head's
    // own non-delegated NEW clients + delegated assignments whose
    // backing client row is < 24h old. The delegated branch now reads
    // from the already-filtered map (A5-P2-3).
    const personallyManagedNew24h = personallyManagedClients.filter(
      (c) => c.created_at >= twentyFourHoursAgo,
    ).length;
    let delegatedNew24h = 0;
    for (const a of openAssignments) {
      const createdAt = delegatedClientCreatedAtById.get(a.client_id);
      if (createdAt && createdAt >= twentyFourHoursAgo) delegatedNew24h++;
    }
    const newClientsLast24h = personallyManagedNew24h + delegatedNew24h;

    // Team aggregates in parallel.
    //
    // P1-7 fix round 5: every payment aggregate is now scoped by
    // client_user_id IN tenantClientIds, NOT coach_user_id IN
    // {head, ...subs}. This ensures a sub-coach's INDEPENDENT clients
    // (those not delegated to them by the head) do not contribute to
    // the head coach's revenue, MRR, or dunning figures. The dunning
    // SQL is updated symmetrically to filter ClientPurchase by
    // client_user_id.
    //
    // Empty tenant short-circuit: if the head coach has no clients
    // (no own clients AND no delegations) we MUST NOT issue a query
    // with `in: []` — some Prisma versions match all rows for an
    // empty list — nor a SQL ANY() against an empty text[]. Instead
    // we project zero results directly into the same downstream
    // shape the aggregate Promise.all would have produced.
    let revenueTodayCents = 0;
    let revenueTodayCount = 0;
    let revenue30dCents = 0;
    // A5-P1-5 — MRR is now computed as a SQL-side aggregate so a
    // tenant with thousands of active recurring subscriptions does
    // not allocate one Prisma object per row in Node. The pre-fix
    // findMany path loaded the full row set and reduced in JS; the
    // new path projects directly to the sum-of-cents that the brief
    // needs. Pricing semantics match the JS reducer exactly:
    //   - interval='year'  : amount_cents / (12 * COALESCE(count,1))
    //   - interval='month' : amount_cents / COALESCE(count,1)
    //   - other intervals (week / day / null) contribute 0.
    // ROUND() floors the partial cent the same way Math.round() did.
    let mrrProjectedCents = 0;
    let dunningStateRaw: Array<{ count: bigint; total: bigint | null }> = [];

    if (tenantClientIds.length > 0) {
      const [revenueTodayAgg, revenue30dAgg, mrrAgg, dunningRows] = await Promise.all([
        this.prisma.clientPurchase.aggregate({
          _sum: { amount_cents: true },
          _count: { _all: true },
          where: {
            client_user_id: { in: tenantClientIds },
            status: 'paid',
            updated_at: { gte: briefDateStart, lte: briefDateEnd },
          },
        }),
        this.prisma.clientPurchase.aggregate({
          _sum: { amount_cents: true },
          where: {
            client_user_id: { in: tenantClientIds },
            status: 'paid',
            updated_at: { gte: thirtyDaysAgo },
          },
        }),
        // A5-P1-5: SQL aggregate. SUM(ROUND(per-row monthly equivalent))
        // mirrors the previous reducer's behavior so MRR numbers stay
        // stable across the migration.
        this.prisma.$queryRaw<Array<{ mrr_cents: bigint | null }>>(
          Prisma.sql`
              SELECT COALESCE(SUM(
                CASE
                  WHEN p."interval" = 'year'
                    THEN ROUND(cp."amount_cents"::numeric
                               / (12 * GREATEST(COALESCE(p."interval_count", 1), 1)))
                  WHEN p."interval" = 'month'
                    THEN ROUND(cp."amount_cents"::numeric
                               / GREATEST(COALESCE(p."interval_count", 1), 1))
                  ELSE 0
                END
              ), 0)::bigint AS mrr_cents
              FROM "ClientPurchase" cp
              LEFT JOIN "CoachPackage" p ON p."id" = cp."package_id"
              WHERE cp."client_user_id" = ANY(${tenantClientIds}::text[])
                AND cp."status" = 'active'
                AND cp."billing_type" = 'recurring'
                AND cp."entitlement_active" = true
            `,
        ),
        this.prisma.$queryRaw<Array<{ count: bigint; total: bigint | null }>>(
          Prisma.sql`
              SELECT
                COUNT(*)::bigint AS count,
                COALESCE(SUM(ds."last_failed_amount_cents"), 0)::bigint AS total
              FROM "DunningState" ds
              JOIN "ClientPurchase" cp ON cp."id" = ds."purchase_id"
              WHERE ds."status" = 'active'
                AND cp."client_user_id" = ANY(${tenantClientIds}::text[])
            `,
        ),
      ]);
      revenueTodayCents = revenueTodayAgg._sum.amount_cents ?? 0;
      revenueTodayCount = revenueTodayAgg._count._all ?? 0;
      revenue30dCents = revenue30dAgg._sum.amount_cents ?? 0;
      mrrProjectedCents = Number(mrrAgg[0]?.mrr_cents ?? 0);
      dunningStateRaw = dunningRows;
    }

    const dunningInProgress = Number(dunningStateRaw[0]?.count ?? 0);
    const dunningAmountCents = Number(dunningStateRaw[0]?.total ?? 0);

    // P1-4: sub-coach highlights derived from SubCoachAssignment, NOT
    // User.coach_id. Each sub-coach's active_clients = open assignments
    // pointing at them; new_clients_24h = those whose backing User row
    // was created in the last 24h.
    const subCoachHighlights: SubCoachHighlight[] = subCoaches
      .map((sc) => {
        const sub = sc.sub_coach;
        if (!sub) return null;
        const clientSet = clientsBySubCoach.get(sub.id) ?? new Set<string>();
        let new24h = 0;
        for (const cid of clientSet) {
          const createdAt = delegatedClientCreatedAtById.get(cid);
          if (createdAt && createdAt >= twentyFourHoursAgo) new24h++;
        }
        return {
          coach_name: sub.name,
          active_clients: clientSet.size,
          new_clients_24h: new24h,
        };
      })
      .filter((s): s is SubCoachHighlight => s !== null)
      .sort((a, b) => b.active_clients - a.active_clients)
      .slice(0, 3);

    const context: BriefContextHeadCoach = {
      brief_mode: 'head_coach',
      date: briefDate,
      coach_name: coachName,
      coach_first_name: coachFirstName,
      team_size: subCoaches.length,
      team_clients_total: teamClientsTotal,
      new_clients_last_24h: newClientsLast24h,
      total_revenue_today_cents: revenueTodayCents,
      team_revenue_30d_cents: revenue30dCents,
      mrr_projected_cents: mrrProjectedCents,
      paid_today_count: revenueTodayCount,
      dunning_in_progress: dunningInProgress,
      dunning_amount_cents: dunningAmountCents,
      sub_coach_highlights: subCoachHighlights,
    };

    // Business-only action items — never client identifiers.
    const actionItems = buildHeadCoachActionItems(context);

    return { context, actionItems };
  }

  // ── Anthropic call with AbortController + 15s timeout + mode-aware
  // system prompt. NEVER throws — Claude failures fall back to a
  // deterministic narrative.
  async callClaude(
    ctx: BriefContext | BriefContextHeadCoach,
  ): Promise<{ narrative: string; generated_by: 'ai' | 'fallback' }> {
    // Fast-path fallback for zero-action briefs — no Claude call needed.
    // Solo/sub-coach mode keys off client-level action counters; head-
    // coach mode keys off team-level business signals (revenue,
    // dunning, headcount changes).
    if (ctx.brief_mode === 'head_coach') {
      const headlineActivity =
        ctx.total_revenue_today_cents + ctx.dunning_in_progress + ctx.new_clients_last_24h;
      if (headlineActivity === 0) {
        return {
          narrative: buildFallbackNarrative(ctx),
          generated_by: 'fallback',
        };
      }
    } else {
      const actionCount =
        ctx.workouts_pending_approval +
        (ctx.missed_checkin > 0 ? 1 : 0) +
        ctx.weight_logs_flagged +
        ctx.unread_messages;

      if (actionCount === 0 && ctx.checked_in_today > 0) {
        return {
          narrative: buildFallbackNarrative(ctx),
          generated_by: 'fallback',
        };
      }
    }

    let client: Anthropic;
    try {
      client = this.getAnthropicClient();
    } catch (err) {
      // ANTHROPIC_API_KEY missing — never propagate as 500 to coach.
      this.logger.error(`CoachBrief Anthropic client init failed: ${errorMessageOf(err)}`);
      return {
        narrative: buildFallbackNarrative(ctx),
        generated_by: 'fallback',
      };
    }

    const systemPrompt =
      ctx.brief_mode === 'head_coach' ? buildHeadCoachSystemPrompt() : buildSoloCoachSystemPrompt();
    const userPrompt = buildBriefPrompt(ctx);
    // P1-8: every downstream prompt-or-log interpolation of the
    // coach's name (repair prompt, contract validator, log lines)
    // must run through sanitizePromptIdentifier so a malicious
    // User.name cannot smuggle newlines, fake system delimiters, or
    // injection payloads into the Claude conversation.
    const safeCoachFirstName = sanitizePromptIdentifier(ctx.coach_first_name);
    const safeCoachName = sanitizePromptIdentifier(ctx.coach_name);

    // P1-7: validate Claude output against the voice contract. On
    // violation, try one repair round-trip with the violation reason
    // appended, then fall back to the deterministic narrative.
    const firstAttempt = await this.invokeClaudeOnce(client, systemPrompt, userPrompt);
    if (firstAttempt.kind === 'success') {
      const violation = validateClaudeNarrative(firstAttempt.narrative, safeCoachFirstName);
      if (!violation) {
        return { narrative: firstAttempt.narrative, generated_by: 'ai' };
      }
      this.logger.warn(
        `CoachBrief Claude output failed contract (${violation}) for coach=${safeCoachName}; attempting one repair`,
      );

      const repairPrompt = `${userPrompt}\n\nYour previous response violated the contract (${violation}). Output a fresh brief that:\n- Is exactly 3 to 5 complete sentences (no more, no fewer).\n- Begins with ${safeCoachFirstName} in the very first sentence.\n- Uses first-person plural TGP voice ("we", "we're", "we've") at least once.\n- Contains no markdown, no bullet points, no meta prefix like "Here is".\n- Stays under ${BRIEF_MAX_NARRATIVE_CHARS} characters.`;

      const secondAttempt = await this.invokeClaudeOnce(client, systemPrompt, repairPrompt);
      if (secondAttempt.kind === 'success') {
        const violation2 = validateClaudeNarrative(secondAttempt.narrative, safeCoachFirstName);
        if (!violation2) {
          return { narrative: secondAttempt.narrative, generated_by: 'ai' };
        }
        this.logger.warn(
          `CoachBrief Claude repair attempt also failed contract (${violation2}) for coach=${safeCoachName}; using fallback`,
        );
      } else {
        this.logger.warn(
          `CoachBrief Claude repair attempt errored for coach=${safeCoachName}: ${secondAttempt.error}`,
        );
      }
    } else {
      this.logger.error(
        `CoachBrief Claude call failed for coach=${safeCoachName}: ${firstAttempt.error}`,
      );
    }

    return {
      narrative: buildFallbackNarrative(ctx),
      generated_by: 'fallback',
    };
  }

  // Single Claude round-trip with AbortController + 15 s timeout. Never
  // throws — returns a discriminated result so callers can branch on
  // success vs. error without `try/catch` plumbing.
  private async invokeClaudeOnce(
    client: Anthropic,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<{ kind: 'success'; narrative: string } | { kind: 'error'; error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BRIEF_ANTHROPIC_TIMEOUT_MS);
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
      const rawText = block && block.type === 'text' ? block.text.trim() : '';
      if (!rawText) {
        throw new CoachBriefClaudeError('COACH_BRIEF_CLAUDE_EMPTY', 'Empty Claude response');
      }
      const normalized = normalizeClaudeOutput(rawText);
      const clamped =
        normalized.length > BRIEF_MAX_NARRATIVE_CHARS
          ? normalized.slice(0, BRIEF_MAX_NARRATIVE_CHARS)
          : normalized;
      return { kind: 'success', narrative: clamped };
    } catch (err) {
      return { kind: 'error', error: errorMessageOf(err) };
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
    // P1-1: a row may be stuck in status='generating' if the previous
    // worker crashed or timed out. Anything older than
    // BRIEF_GENERATION_LEASE_MS is considered stale and can be reclaimed
    // by the next caller. We use the timestamp at the start of this
    // request so two callers within the same lease window agree on what
    // counts as "stale".
    const leaseCutoff = new Date(Date.now() - BRIEF_GENERATION_LEASE_MS);
    const nowTs = new Date();

    if (opts.force) {
      // Atomic claim for forced regeneration: flip the row to
      // 'generating' UNLESS another caller already holds a fresh lease.
      // A stale 'generating' lease (older than leaseCutoff) IS reclaimed
      // here so a crashed worker cannot block force-regenerate forever.
      const claim = await this.prisma.coachBrief.updateMany({
        where: {
          coach_id: coachId,
          brief_date: briefDate,
          OR: [
            { status: { not: 'generating' } },
            { generation_started_at: null },
            { generation_started_at: { lt: leaseCutoff } },
          ],
        },
        data: {
          status: 'generating',
          generated_at: null,
          generation_started_at: nowTs,
        },
      });

      if (claim.count === 0) {
        // Either no row yet, or a fresh 'generating' lease is in flight.
        // Try to create the row — if that loses the race a concurrent
        // regenerate already claimed; return that.
        try {
          await this.prisma.coachBrief.create({
            data: {
              coach_id: coachId,
              brief_date: briefDate,
              status: 'generating',
              generation_started_at: nowTs,
            },
          });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
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
        // Fresh lease — another worker is actively generating. Return as
        // pending so the client polls instead of triggering a duplicate
        // Claude call.
        const startedAt = existing.generation_started_at;
        if (startedAt && startedAt >= leaseCutoff) {
          return this.toResponse(existing);
        }
        // Stale lease — the previous worker crashed or timed out. Steal
        // the lease atomically (only the caller whose updateMany returns
        // count=1 proceeds; the loser sees a fresh lease and returns).
        const stolen = await this.prisma.coachBrief.updateMany({
          where: {
            coach_id: coachId,
            brief_date: briefDate,
            status: 'generating',
            OR: [{ generation_started_at: null }, { generation_started_at: { lt: leaseCutoff } }],
          },
          data: {
            status: 'generating',
            generated_at: null,
            generation_started_at: nowTs,
          },
        });
        if (stolen.count === 0) {
          // Another caller stole the lease first; surface whatever is
          // current so the client polls again.
          const fresh = await this.prisma.coachBrief.findUnique({
            where: {
              CoachBrief_coach_date_key: {
                coach_id: coachId,
                brief_date: briefDate,
              },
            },
          });
          if (fresh) return this.toResponse(fresh);
        }
        // We now own the claim — fall through to the generation block.
      } else {
        try {
          const created = await this.prisma.coachBrief.create({
            data: {
              coach_id: coachId,
              brief_date: briefDate,
              status: 'generating',
              generation_started_at: nowTs,
            },
          });
          // Sanity — we own the claim only because create succeeded.
          void created;
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
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
    }

    // From here on we OWN the generating-row. Do the work and finalize.
    try {
      const briefMode = await this.detectBriefMode(coachId);

      let context: BriefContext | BriefContextHeadCoach;
      let actionItems: ActionItem[] | HeadCoachActionItem[];

      if (briefMode === 'head_coach') {
        // P1-3: head-coach is business-only. No client scope queries,
        // no per-client action items, no client_id in the response.
        const headRes = await this.aggregateHeadCoachContext(coachId, timezone, briefDate);
        context = headRes.context;
        actionItems = headRes.actionItems;
      } else {
        const clientIds = await this.resolveClientScope(coachId, briefMode);
        const agg = await this.aggregateSoloContext(
          coachId,
          clientIds,
          timezone,
          briefDate,
          briefMode,
        );
        if (briefMode === 'sub_coach') {
          agg.context.brief_mode = 'sub_coach';
        }
        context = agg.context;
        actionItems = buildActionItems({
          pendingWorkouts: agg.pendingWorkouts,
          unreadThreads: agg.unreadThreads,
          flaggedWeightLogs: agg.flaggedWeightLogs,
          missingCheckinClients: agg.missingCheckinClients,
        });
      }

      const { narrative, generated_by } = await this.callClaude(context);

      // H6 (D-H6-3): a generated brief aggregates client PII into a narrative
      // — finalizing it is an auditable write. afterState carries metadata
      // only (status, generator, lengths), never the narrative body (R98).
      const finalizeArgs = {
        where: {
          CoachBrief_coach_date_key: {
            coach_id: coachId,
            brief_date: briefDate,
          },
        },
        data: {
          status: 'generated',
          generated_at: new Date(),
          // Clear the lease so a future stale-lease scan does not
          // accidentally flag this freshly-generated row.
          generation_started_at: null,
          narrative,
          brief_context: context as unknown as Prisma.JsonObject,
          action_items: actionItems as unknown as Prisma.JsonArray,
          generated_by,
          brief_mode: briefMode,
        },
      } as const;
      const updated = this.auditLog
        ? await this.auditLog.withAuditLog(
            {
              tenantId: coachId,
              actorId: coachId,
              actorType: 'coach',
              action: 'update',
              resourceType: 'CoachBrief',
              afterState: {
                status: 'generated',
                generated_by,
                narrative_length: narrative?.length ?? 0,
                action_item_count: Array.isArray(actionItems) ? actionItems.length : 0,
              },
              reason: 'coach-brief.generated',
            },
            (tx) => tx.coachBrief.update(finalizeArgs),
          )
        : await this.prisma.coachBrief.update(finalizeArgs);

      return this.toResponse(updated);
    } catch (err) {
      // Release the claim so the next request can retry. We do not
      // distinguish failures here — the next caller will re-claim.
      this.logger.error(
        `CoachBrief generation failed for coach=${coachId}: ${errorMessageOf(err)}`,
      );
      // P1-10 fix round 5: a failed cleanup is itself a real incident.
      // The previous `.catch(() => undefined)` silently masked
      // database errors here — if the cleanup throws, every
      // subsequent generateBrief call for this (coach, briefDate)
      // sees status='generating' with an exhausted lease and either
      // refuses to retry or repeatedly fails to claim. Surface the
      // cleanup failure as a distinct structured log so on-call can
      // see it without losing the original generation error (which
      // is still re-thrown below).
      try {
        await this.prisma.coachBrief.updateMany({
          where: {
            coach_id: coachId,
            brief_date: briefDate,
            status: 'generating',
          },
          data: { status: 'failed', generation_started_at: null },
        });
      } catch (cleanupErr) {
        this.logger.error(
          `CoachBrief generation cleanup also failed for coach=${coachId} date=${briefDate} primary=${errorMessageOf(err)} cleanup=${errorMessageOf(cleanupErr)}`,
        );
      }
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

  /**
   * Audit P0-5 — mark a brief as read.
   *
   * Sets `read_at = now()` exactly once. Subsequent calls for the same
   * (coachId, briefId) are no-ops (the WHERE refuses to update once
   * read_at is non-null). Tenant scope: we require `coach_id = coachId`
   * so a coach can never mark another coach's brief read — important
   * because dormancy attribution relies on the per-coach read count.
   *
   * Returns `{ already_read: true }` when the brief was previously read
   * so the mobile client can avoid an extra round-trip on idempotent
   * retries.
   *
   * Wired into:
   *   - `POST /coach/brief/:id/read` (the dedicated endpoint)
   *   - Dormancy guard (`DormancyGuardService.shouldSkipCoach`) reads
   *     this column to decide cost-protection skips.
   */
  async markBriefRead(
    coachId: string,
    briefId: string,
  ): Promise<{ id: string; read_at: string; already_read: boolean }> {
    const now = new Date();
    // Atomic conditional UPDATE — only write if (a) the brief belongs
    // to this coach, AND (b) read_at is currently null. result.count
    // tells us which branch we landed in.
    // H6 (D-H6-3): a coach brief aggregates client PII; marking it read is
    // an access-state mutation, so wrap it in withAuditLog().
    const markReadArgs = {
      where: { id: briefId, coach_id: coachId, read_at: null },
      data: { read_at: now },
    } as const;
    const result = this.auditLog
      ? await this.auditLog.withAuditLog(
          {
            tenantId: coachId,
            actorId: coachId,
            actorType: 'coach',
            action: 'update',
            resourceType: 'CoachBrief',
            resourceId: briefId,
            afterState: { read: true },
            reason: 'coach_brief.marked_read',
          },
          (tx) => tx.coachBrief.updateMany(markReadArgs),
        )
      : await this.prisma.coachBrief.updateMany(markReadArgs);
    if (result.count > 0) {
      return { id: briefId, read_at: now.toISOString(), already_read: false };
    }
    // Either the brief doesn't belong to this coach, doesn't exist, or
    // is already read. Read it back to disambiguate.
    const existing = await this.prisma.coachBrief.findFirst({
      where: { id: briefId, coach_id: coachId },
      select: { id: true, read_at: true },
    });
    if (!existing) {
      // Throw a 404-ish — let the caller decide on the HTTP shape.
      // We use NotFoundException at the controller layer to keep the
      // service framework-agnostic.
      throw new BriefNotFoundError(briefId);
    }
    return {
      id: existing.id,
      // existing.read_at is guaranteed non-null here (count was 0 above
      // and the brief exists for this coach → it was already read).
      read_at: (existing.read_at ?? now).toISOString(),
      already_read: true,
    };
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
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const cutoff = bucketDateLocal(thirtyDaysAgo, timezone);
    const today = bucketDateLocal(now, timezone);

    // A5-P2-2 — include 'failed' rows so a Claude-outage day stays
    // visible to the coach (mobile renders the deterministic-fallback
    // narrative for failed rows). 'generating' and 'pending' rows are
    // excluded because they have no displayable summary yet — they
    // belong on the today/regenerate surface, not the history list.
    // The upper bound `lte: today` blocks accidentally-staged future
    // briefs from leaking into the coach-visible feed.
    const where: Prisma.CoachBriefWhereInput = {
      coach_id: coachId,
      status: { in: ['generated', 'failed'] },
      brief_date: { gte: cutoff, lte: today },
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

  // ── GDPR Art.17 TTL prune — deletes CoachBrief rows older than
  // retentionDays. Client PII (first names, metrics) embedded in
  // brief_context JSON ages out within this window without needing a
  // client_id FK on the table. Called daily by CoachBriefScheduler at
  // 03:15 UTC (off-peak, well after the 05:00 push generation window).
  // Wrapped in $transaction for safety; counts are logged at LOG level
  // so operators can confirm rows are being pruned.
  async pruneStaleBriefs(retentionDays = 7): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - retentionDays);
    // brief_date is stored as a 'YYYY-MM-DD' string (Prisma String, Postgres
    // DATE).  Comparing as ISO date string works because lexicographic order
    // equals chronological order for that format.
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);

    const [result] = await this.prisma.$transaction([
      this.prisma.coachBrief.deleteMany({
        where: { brief_date: { lt: cutoffStr } },
      }),
    ]);

    this.logger.log(
      `CoachBrief TTL prune: deleted ${result.count} rows older than ${cutoffStr} (retentionDays=${retentionDays})`,
    );
    return result.count;
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
    // A5-P1-6 — surface 'generating' explicitly so mobile can
    // distinguish "claimed and in-flight" from "not started yet"
    // and choose the poll interval accordingly. Only the unknown
    // / legacy values fall back to 'pending'.
    const status: BriefStatus =
      row.status === 'generated' || row.status === 'generating' || row.status === 'failed'
        ? (row.status as BriefStatus)
        : 'pending';
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
      const generatedBy = row.generated_by === 'ai' ? 'ai' : 'fallback';
      // Prisma persists brief_context as Json; the runtime shape is one of the
      // two domain unions. Narrow via JSON round-trip (no `as`-double-cast —
      // R75 banned-cast hygiene) so the value is structurally re-typed.
      const briefContext = JSON.parse(JSON.stringify(row.brief_context)) as
        | BriefContext
        | BriefContextHeadCoach;
      summary = {
        date: row.brief_date,
        brief_mode: briefMode,
        narrative: row.narrative,
        brief_context: briefContext,
        // Head-coach action items are HeadCoachActionItem[] (no
        // client_id / client_name); solo + sub-coach use ActionItem[].
        // The union in BriefSummary covers both shapes.
        action_items:
          briefMode === 'head_coach'
            ? (row.action_items as unknown as HeadCoachActionItem[])
            : (row.action_items as unknown as ActionItem[]),
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

// P1-8: timezone-aware day boundaries. The previous implementation only
// pulled the hour from Intl.DateTimeFormat, which silently truncated
// half-hour and quarter-hour offsets (Asia/Kolkata UTC+5:30,
// Asia/Kathmandu UTC+5:45, Australia/Adelaide UTC+9:30, etc.) AND
// assumed every local day is exactly 24 hours, which is false on DST
// transitions (US spring-forward is 23h, fall-back is 25h).
//
// We now solve the boundary problem analytically: given a target
// (briefDate, timeZone) and a candidate UTC instant, compute the actual
// UTC↔local offset at that instant by reading FULL Intl parts
// (year/month/day/hour/minute/second), then snap the candidate so its
// local rendering equals briefDate 00:00:00 (or 23:59:59.999).
//
// This is exported so timezone behaviour can be unit-tested without
// touching the service.
export function startOfDayInTz(briefDate: string, timeZone: string): Date {
  const [y, m, d] = briefDate.split('-').map(Number);
  return zonedWallClockToUtc(
    { year: y, month: m, day: d, hour: 0, minute: 0, second: 0, ms: 0 },
    timeZone,
  );
}

export function endOfDayInTz(briefDate: string, timeZone: string): Date {
  const [y, m, d] = briefDate.split('-').map(Number);
  return zonedWallClockToUtc(
    {
      year: y,
      month: m,
      day: d,
      hour: 23,
      minute: 59,
      second: 59,
      ms: 999,
    },
    timeZone,
  );
}

interface WallClock {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

// Convert a (year, month, day, hh:mm:ss.ms) wall-clock value in the
// given IANA timezone into the corresponding UTC instant.
//
// Algorithm: estimate the offset by treating the wall-clock as UTC,
// then iterate up to 3 times — each iteration reads the offset at the
// candidate UTC instant and shifts by the difference between observed
// wall-clock and target wall-clock. Three iterations is the upper
// bound under standard DST rules (offset shifts are at most 2 hours
// from a single move), and we tolerate up to ±1 ms of residual error.
function zonedWallClockToUtc(wc: WallClock, timeZone: string): Date {
  // Initial guess — treat the wall-clock as UTC. This is wrong by the
  // tz offset, but the iteration converges in 1–2 steps.
  let guess = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second, wc.ms);
  const targetMillisInDay = ((wc.hour * 60 + wc.minute) * 60 + wc.second) * 1000 + wc.ms;
  const targetDateNum = wc.year * 10000 + wc.month * 100 + wc.day;

  for (let i = 0; i < 4; i++) {
    const observed = readWallClockInTz(new Date(guess), timeZone);
    const observedDateNum = observed.year * 10000 + observed.month * 100 + observed.day;
    const observedMillisInDay =
      ((observed.hour * 60 + observed.minute) * 60 + observed.second) * 1000 + observed.ms;

    // Diff in calendar days × 86_400_000 ms + diff in time-of-day ms.
    // We approximate the day diff using Date.UTC of midnight in each
    // calendar position, which is exact (no DST inside UTC).
    const targetMidnightUtc = Date.UTC(wc.year, wc.month - 1, wc.day);
    const observedMidnightUtc = Date.UTC(observed.year, observed.month - 1, observed.day);
    const dayDeltaMs = targetMidnightUtc - observedMidnightUtc;
    const tofDeltaMs = targetMillisInDay - observedMillisInDay;
    const totalDelta = dayDeltaMs + tofDeltaMs;

    if (totalDelta === 0 && observedDateNum === targetDateNum) {
      return new Date(guess);
    }
    guess += totalDelta;
  }
  return new Date(guess);
}

// Read the formatted local wall-clock of a UTC instant in the given
// IANA timezone, with full minute/second precision.
function readWallClockInTz(d: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const pick = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  let hour = pick('hour');
  // Intl emits '24' for midnight on some engines; normalise.
  if (hour === 24) hour = 0;
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour,
    minute: pick('minute'),
    second: pick('second'),
    ms: d.getUTCMilliseconds(),
  };
}
