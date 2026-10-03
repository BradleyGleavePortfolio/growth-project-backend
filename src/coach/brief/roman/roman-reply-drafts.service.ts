// src/coach/brief/roman/roman-reply-drafts.service.ts
//
// A5-COACH-BRIEF — Roman triage + reply draft for every unread client
// message, reviewed and sent only by the coach.
//
// Reuses, never forks, the existing seams:
//   - AiEgressService — the single consent gate. Only clients holding a live
//     box-2 grant get a draft; their grant is read before the claim and again
//     by the gate at send time. Everyone else is counted, never sent.
//   - AiActionDraft + CoachMessageMaterializer + AiApprovalService.decide —
//     the one AI-draft approve/send path (draft.coach_message). A draft is a
//     pending AiActionDraft; nothing reaches the client until the coach taps
//     Send, which runs decide('approved') and the materialiser's exactly-once
//     send. requester_id is null because Roman, not the coach, proposed it, so
//     the "requester never approves their own draft" rule lets the coach decide.
//   - AuditService — one audit row per generated and per edited draft; decide()
//     writes ai.draft_approved / ai.draft_rejected for send and dismiss.
//
// RomanReplyDraft (server-only table) is the idempotency claim: one row per
// (coach, source message), so restarts, two devices and the daily brief can
// never produce two drafts for the same message.

import { COACH_AI_MODEL } from '../../../ai/coach/coach-ai.constants';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../../prisma.service';
import { AiEgressService, AnthropicHandle } from '../../../ai-egress/ai-egress.service';
import { clientDataSubject } from '../../../ai-egress/ai-egress.types';
import { createAnthropicClient } from '../../../ai-egress/provider-clients';
import { isAiEgressRefusal } from '../../../ai-egress/ai-consent-required.exception';
import { AiApprovalService } from '../../../ai/gateway/ai-approval.service';
import {
  COACH_MESSAGE_CAPABILITY,
  assertCoachMessagePayload,
} from '../../../ai/gateway/materialisers/coach-message.materialiser';
import { AuditService } from '../../../audit/audit.service';
import {
  ROMAN_DRAFT_CATEGORIES,
  ROMAN_DRAFT_CONTEXT_TURNS,
  ROMAN_DRAFT_URGENCIES,
  ROMAN_DRAFT_PROMPT_VERSION,
  RomanDraftCategory,
  RomanDraftTurn,
  RomanDraftUrgency,
  buildRomanDraftSystemPrompt,
  buildRomanDraftUserPrompt,
  finalizeRomanReply,
  parseRomanDraftOutput,
} from './roman-reply-draft.prompt';
import { RomanDraftError } from './roman-errors';
import { safeFirstName } from './roman-highlights';

export const ROMAN_DRAFT_ANTHROPIC_CLIENT_TOKEN = 'ROMAN_DRAFT_ANTHROPIC_CLIENT';
/** Same model family as the coach brief narrative. */
// Shared model config (never a literal id here; see BRIEF_CLAUDE_MODEL).
export const ROMAN_DRAFT_MODEL: string = COACH_AI_MODEL;
export const ROMAN_DRAFT_MAX_TOKENS = 500;
export const ROMAN_DRAFT_TEMPERATURE = 0.4;
export const ROMAN_DRAFT_TIMEOUT_MS = 12_000;
/** A 'generating' claim older than this is presumed crashed and may be retaken. */
export const ROMAN_DRAFT_CLAIM_LEASE_MS = 2 * 60 * 1000;
/** A failed draft is retried no sooner than this. */
export const ROMAN_DRAFT_RETRY_AFTER_MS = 15 * 60 * 1000;
/** New generations started per prepare call (bounds cost and latency). */
export const ROMAN_DRAFT_MAX_NEW_PER_CALL = 10;
/** Pending AiActionDraft lifetime, matching the gateway's 7-day default. */
export const ROMAN_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ROMAN_DRAFT_RATIONALE = 'roman_reply_draft';
const UNREAD_SCAN_LIMIT = 300;
const PREVIEW_MAX_CHARS = 280;
const URGENCY_RANK: Record<string, number> = { today: 0, soon: 1, whenever: 2 };

export interface PrepareDraftsResult {
  clients: number;
  drafted: number;
  drafts_failed: number;
  /** Consenting clients whose draft was not started in this call (budget). */
  drafts_pending: number;
  without_ai_consent_clients: number;
  without_ai_consent_messages: number;
  /** First names of clients with unread messages, most recent first. */
  client_names: Array<string | null>;
}

export interface RomanDraftItem {
  id: string;
  draft_id: string;
  client: { id: string; name: string; first_name: string | null };
  message: { id: string; preview: string; created_at: string; unread_count: number };
  reply: string;
  category: RomanDraftCategory | null;
  urgency: RomanDraftUrgency | null;
  created_at: string;
}

export interface RomanManualReplyItem {
  client: { id: string; name: string; first_name: string | null };
  latest_message_at: string;
  unread_count: number;
  reason: 'no_ai_consent' | 'draft_failed' | 'voice_only' | 'draft_pending' | 'draft_dismissed';
  deep_link: string;
}

export interface RomanDraftQueue {
  drafts: RomanDraftItem[];
  manual: RomanManualReplyItem[];
  summary: PrepareDraftsResult;
}

export interface RomanDraftSendResult {
  status: 'sent';
  id: string;
  draft_id: string;
  message_id: string;
  edited: boolean;
}

interface UnreadThread {
  clientId: string;
  clientName: string;
  threadCoachId: string | null;
  source: { id: string; body: string | null; created_at: Date };
  unread: number;
}

type DraftOutcome =
  'drafted' | 'failed' | 'pending' | 'voice_only' | 'no_consent' | 'handled' | 'dismissed';

@Injectable()
export class RomanReplyDraftsService {
  private readonly logger = new Logger(RomanReplyDraftsService.name);
  private anthropic: AnthropicHandle | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly egress: AiEgressService,
    private readonly approvals: AiApprovalService,
    private readonly audit: AuditService,
    @Optional()
    @Inject(ROMAN_DRAFT_ANTHROPIC_CLIENT_TOKEN)
    injectedClient?: AnthropicHandle,
  ) {
    if (injectedClient) this.anthropic = injectedClient;
  }

  private getAnthropicClient(): AnthropicHandle | null {
    if (this.anthropic) return this.anthropic;
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey || !apiKey.trim()) return null;
    this.anthropic = createAnthropicClient(apiKey);
    return this.anthropic;
  }

  // ── Unread inbound messages per client (the client authored them). ─────
  private async unreadThreads(
    coachId: string,
    clientIds: readonly string[],
  ): Promise<UnreadThread[]> {
    if (clientIds.length === 0) return [];
    const rows = await this.prisma.coachMessage.findMany({
      where: {
        client_id: { in: [...clientIds] },
        read_at: null,
        sender_id: { in: [...clientIds] },
        NOT: { sender_id: coachId },
      },
      select: {
        id: true,
        client_id: true,
        coach_id: true,
        sender_id: true,
        body: true,
        created_at: true,
        client: { select: { name: true } },
      },
      orderBy: { created_at: 'desc' },
      take: UNREAD_SCAN_LIMIT,
    });
    const byClient = new Map<string, UnreadThread>();
    for (const m of rows) {
      // Only the client's own words: a message the client authored in
      // their own thread.
      if (!m.client_id || m.sender_id !== m.client_id) continue;
      const existing = byClient.get(m.client_id);
      if (existing) {
        existing.unread += 1;
        continue;
      }
      byClient.set(m.client_id, {
        clientId: m.client_id,
        clientName: m.client?.name ?? '',
        threadCoachId: m.coach_id,
        source: { id: m.id, body: m.body, created_at: m.created_at },
        unread: 1,
      });
    }
    return [...byClient.values()];
  }

  /**
   * Make sure every unread client thread in `clientIds` has a Roman draft for
   * its latest message, within a call budget. Consent-filtered; idempotent
   * per source message; never throws for a single thread's failure.
   */
  async prepareDrafts(
    coachId: string,
    coachName: string | null,
    clientIds: readonly string[],
    opts: { maxNew?: number; deadlineMs?: number } = {},
  ): Promise<PrepareDraftsResult> {
    const threads = await this.unreadThreads(coachId, clientIds);
    const outcomes = await this.ensureDrafts(coachId, coachName, threads, opts);
    return this.summarise(threads, outcomes);
  }

  private summarise(
    threads: UnreadThread[],
    outcomes: Map<string, DraftOutcome>,
  ): PrepareDraftsResult {
    const r: PrepareDraftsResult = {
      clients: threads.length,
      drafted: 0,
      drafts_failed: 0,
      drafts_pending: 0,
      without_ai_consent_clients: 0,
      without_ai_consent_messages: 0,
      client_names: threads.map((t) => safeFirstName(t.clientName)),
    };
    for (const t of threads) {
      const o = outcomes.get(t.clientId);
      if (o === 'drafted') r.drafted += 1;
      else if (o === 'failed' || o === 'voice_only') r.drafts_failed += 1;
      else if (o === 'pending') r.drafts_pending += 1;
      else if (o === 'handled' || o === 'dismissed') continue;
      else {
        r.without_ai_consent_clients += 1;
        r.without_ai_consent_messages += t.unread;
      }
    }
    return r;
  }

  private async ensureDrafts(
    coachId: string,
    coachName: string | null,
    threads: UnreadThread[],
    opts: { maxNew?: number; deadlineMs?: number },
  ): Promise<Map<string, DraftOutcome>> {
    const outcomes = new Map<string, DraftOutcome>();
    if (threads.length === 0) return outcomes;
    // R2b — box-2 filter BEFORE anything about these clients is read for AI.
    const consented = await this.egress.consentedClients(threads.map((t) => t.clientId));
    const maxNew = opts.maxNew ?? ROMAN_DRAFT_MAX_NEW_PER_CALL;
    const deadline = opts.deadlineMs ? Date.now() + opts.deadlineMs : Number.POSITIVE_INFINITY;
    let started = 0;
    for (const t of threads) {
      if (!consented.has(t.clientId)) {
        outcomes.set(t.clientId, 'no_consent');
        continue;
      }
      const existing = await this.prisma.romanReplyDraft.findUnique({
        where: {
          coach_id_source_message_id: { coach_id: coachId, source_message_id: t.source.id },
        },
        select: {
          id: true,
          status: true,
          ai_draft_id: true,
          generation_started_at: true,
          updated_at: true,
          ai_draft: { select: { status: true } },
        },
      });
      if (existing && existing.status === 'ready') {
        const s = existing.ai_draft?.status;
        // pending -> ready for review; approved -> the coach already sent it;
        // rejected -> the coach chose to answer personally; expired -> stale.
        outcomes.set(
          t.clientId,
          s === 'pending'
            ? 'drafted'
            : s === 'approved'
              ? 'handled'
              : s === 'rejected'
                ? 'dismissed'
                : 'failed',
        );
        continue;
      }
      if (await this.coachRepliedSince(t.clientId, t.source.created_at)) {
        // The thread already moved on; a draft would answer an old message.
        outcomes.set(t.clientId, 'handled');
        continue;
      }
      if (!t.source.body || !t.source.body.trim()) {
        outcomes.set(t.clientId, 'voice_only');
        continue;
      }
      const now = Date.now();
      const leaseFresh =
        existing?.status === 'generating' &&
        existing.generation_started_at !== null &&
        now - existing.generation_started_at.getTime() < ROMAN_DRAFT_CLAIM_LEASE_MS;
      const failedRecently =
        existing?.status === 'failed' &&
        now - existing.updated_at.getTime() < ROMAN_DRAFT_RETRY_AFTER_MS;
      if (leaseFresh) {
        outcomes.set(t.clientId, 'pending');
        continue;
      }
      if (failedRecently) {
        outcomes.set(t.clientId, 'failed');
        continue;
      }
      if (started >= maxNew || Date.now() >= deadline) {
        outcomes.set(t.clientId, 'pending');
        continue;
      }
      started += 1;
      outcomes.set(t.clientId, await this.generateOne(coachId, coachName, t, existing?.id ?? null));
    }
    return outcomes;
  }

  /** Claim (or re-claim) the (coach, source) row, generate, persist. */
  private async generateOne(
    coachId: string,
    coachName: string | null,
    t: UnreadThread,
    existingId: string | null,
  ): Promise<DraftOutcome> {
    const claimedAt = new Date();
    let claimId: string;
    if (existingId) {
      // Retake a stale 'generating' lease or a retry-eligible 'failed' row.
      const retake = await this.prisma.romanReplyDraft.updateMany({
        where: {
          id: existingId,
          OR: [
            {
              status: 'failed',
              updated_at: { lt: new Date(claimedAt.getTime() - ROMAN_DRAFT_RETRY_AFTER_MS) },
            },
            {
              status: 'generating',
              generation_started_at: {
                lt: new Date(claimedAt.getTime() - ROMAN_DRAFT_CLAIM_LEASE_MS),
              },
            },
          ],
        },
        data: { status: 'generating', generation_started_at: claimedAt, failure_code: null },
      });
      if (retake.count === 0) return 'pending';
      claimId = existingId;
    } else {
      try {
        const created = await this.prisma.romanReplyDraft.create({
          data: {
            coach_id: coachId,
            client_id: t.clientId,
            source_message_id: t.source.id,
            status: 'generating',
            generation_started_at: claimedAt,
          },
          select: { id: true },
        });
        claimId = created.id;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          // Another process holds this message's claim: it generates.
          return 'pending';
        }
        throw err;
      }
    }

    try {
      const output = await this.callModel(coachName, t);
      if (!output) {
        await this.markFailed(claimId, 'generation_failed');
        return 'failed';
      }
      const payload = assertCoachMessagePayload({ clientId: t.clientId, body: output.reply });
      const aiDraftId = await this.prisma.$transaction(async (tx) => {
        const draft = await tx.aiActionDraft.create({
          data: {
            capability: COACH_MESSAGE_CAPABILITY,
            status: 'pending',
            requester_id: null,
            subject_user_id: t.clientId,
            tenant_coach_id: coachId,
            payload: { clientId: payload.clientId, body: payload.body },
            rationale: ROMAN_DRAFT_RATIONALE,
            provenance: [
              { source: 'coach_message', ref: t.source.id, prompt: ROMAN_DRAFT_PROMPT_VERSION },
            ],
            expires_at: new Date(Date.now() + ROMAN_DRAFT_TTL_MS),
          },
          select: { id: true },
        });
        const flip = await tx.romanReplyDraft.updateMany({
          where: { id: claimId, status: 'generating', generation_started_at: claimedAt },
          data: {
            status: 'ready',
            ai_draft_id: draft.id,
            category: output.category,
            urgency: output.urgency,
            generated_at: new Date(),
            generation_started_at: null,
          },
        });
        if (flip.count === 0) {
          // Our lease was retaken while the model ran: roll back the draft.
          throw new LeaseLostError();
        }
        return draft.id;
      });
      await this.supersedeOlder(coachId, t.clientId, t.source.id);
      await this.audit.write({
        action: 'roman.reply_draft_generated',
        actorId: null,
        actorRole: 'system',
        targetType: 'ai_action_draft',
        targetId: aiDraftId,
        targetUserId: t.clientId,
        tenantCoachId: coachId,
        metadata: {
          source_message_id: t.source.id,
          category: output.category,
          urgency: output.urgency,
          model: ROMAN_DRAFT_MODEL,
          prompt: ROMAN_DRAFT_PROMPT_VERSION,
        },
      });
      return 'drafted';
    } catch (err) {
      if (err instanceof LeaseLostError) return 'pending';
      if (isAiEgressRefusal(err)) {
        // Grant withdrawn between the filter and the send: nothing was sent.
        await this.markFailed(claimId, 'consent_withdrawn');
        return 'no_consent';
      }
      this.logger.warn(
        `roman reply draft failed coach=${coachId} source=${t.source.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.markFailed(claimId, 'generation_failed');
      return 'failed';
    }
  }

  private async markFailed(id: string, code: string): Promise<void> {
    try {
      await this.prisma.romanReplyDraft.updateMany({
        where: { id, status: 'generating' },
        data: { status: 'failed', failure_code: code, generation_started_at: null },
      });
    } catch (err) {
      this.logger.error(
        `roman reply draft claim release failed id=${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** A newer client message replaces older pending drafts in that thread. */
  private async supersedeOlder(
    coachId: string,
    clientId: string,
    currentSourceId: string,
  ): Promise<void> {
    const older = await this.prisma.romanReplyDraft.findMany({
      where: {
        coach_id: coachId,
        client_id: clientId,
        status: 'ready',
        NOT: { source_message_id: currentSourceId },
      },
      select: { id: true, ai_draft_id: true },
    });
    await this.retire(older, 'superseded_by_newer_message');
  }

  private async retire(
    rows: Array<{ id: string; ai_draft_id: string | null }>,
    note: string,
  ): Promise<void> {
    if (rows.length === 0) return;
    const draftIds = rows.map((r) => r.ai_draft_id).filter((id): id is string => !!id);
    await this.prisma.$transaction([
      this.prisma.aiActionDraft.updateMany({
        where: { id: { in: draftIds }, status: 'pending', materialised_at: null },
        data: { status: 'expired', decision_note: note, decided_at: new Date() },
      }),
      this.prisma.romanReplyDraft.updateMany({
        where: { id: { in: rows.map((r) => r.id) }, status: 'ready' },
        data: { status: 'superseded' },
      }),
    ]);
  }

  /** True when someone other than the client wrote in the thread after `since`. */
  private async coachRepliedSince(clientId: string, since: Date): Promise<boolean> {
    const reply = await this.prisma.coachMessage.findFirst({
      where: { client_id: clientId, created_at: { gt: since }, NOT: { sender_id: clientId } },
      select: { id: true },
    });
    return reply !== null;
  }

  private async threadTurns(t: UnreadThread): Promise<RomanDraftTurn[]> {
    const rows = await this.prisma.coachMessage.findMany({
      where: {
        client_id: t.clientId,
        ...(t.threadCoachId ? { coach_id: t.threadCoachId } : {}),
        created_at: { lte: t.source.created_at },
      },
      select: { sender_id: true, body: true },
      orderBy: { created_at: 'desc' },
      take: ROMAN_DRAFT_CONTEXT_TURNS,
    });
    return rows
      .reverse()
      .filter((r) => typeof r.body === 'string' && r.body.trim().length > 0)
      .map((r) => ({ from: r.sender_id === t.clientId ? 'client' : 'coach', text: r.body ?? '' }));
  }

  /** One model round-trip (+ one repair on unparseable output), or null. */
  private async callModel(
    coachName: string | null,
    t: UnreadThread,
  ): Promise<{ category: RomanDraftCategory; urgency: RomanDraftUrgency; reply: string } | null> {
    const client = this.getAnthropicClient();
    if (!client) return null;
    const turns = await this.threadTurns(t);
    const system = buildRomanDraftSystemPrompt();
    const user = buildRomanDraftUserPrompt({
      coachFirstName: safeFirstName(coachName) ?? 'Coach',
      clientFirstName: safeFirstName(t.clientName) ?? 'there',
      turns,
    });
    const subject = clientDataSubject(t.clientId, 'coach');
    for (let attempt = 0; attempt < 2; attempt++) {
      const content =
        attempt === 0
          ? user
          : `${user}\n\nYour previous answer was not a valid JSON object with category, urgency and reply. Answer again with only that JSON object.`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ROMAN_DRAFT_TIMEOUT_MS);
      let raw = '';
      try {
        // R2b — the gate re-reads this client's box-2 grant on every send.
        const resp = await this.egress.anthropicMessagesCreate(
          client,
          subject,
          'coach.reply_draft',
          {
            model: ROMAN_DRAFT_MODEL,
            max_tokens: ROMAN_DRAFT_MAX_TOKENS,
            temperature: ROMAN_DRAFT_TEMPERATURE,
            system,
            messages: [{ role: 'user', content }],
          },
          { signal: controller.signal },
        );
        const block = resp.content?.find((b) => b.type === 'text');
        raw = block && block.type === 'text' ? block.text : '';
      } finally {
        clearTimeout(timer);
      }
      const parsed = parseRomanDraftOutput(raw);
      if (!parsed) continue;
      const reply = finalizeRomanReply(parsed.reply);
      if (!reply) return null;
      return { category: parsed.category, urgency: parsed.urgency, reply };
    }
    return null;
  }

  // ── Coach review queue ────────────────────────────────────────────────

  /**
   * Everything that needs a reply: ready Roman drafts (sorted by urgency) and
   * the threads the coach answers personally (no consent, voice only, draft
   * failed or still being prepared). Drafts whose thread already moved on
   * (the coach replied after the source message) are retired, not shown.
   */
  async listQueue(
    coachId: string,
    coachName: string | null,
    clientIds: readonly string[],
    opts: { prepare: boolean } = { prepare: true },
  ): Promise<RomanDraftQueue> {
    const threads = await this.unreadThreads(coachId, clientIds);
    const outcomes = opts.prepare
      ? await this.ensureDrafts(coachId, coachName, threads, {})
      : await this.ensureDrafts(coachId, coachName, threads, { maxNew: 0 });
    const summary = this.summarise(threads, outcomes);

    const rows = await this.prisma.romanReplyDraft.findMany({
      where: { coach_id: coachId, status: 'ready', client_id: { in: [...clientIds] } },
      select: {
        id: true,
        ai_draft_id: true,
        client_id: true,
        category: true,
        urgency: true,
        created_at: true,
        client: { select: { name: true } },
        source_message: { select: { id: true, body: true, created_at: true, coach_id: true } },
        ai_draft: { select: { id: true, status: true, payload: true, expires_at: true } },
      },
      orderBy: { created_at: 'desc' },
      take: 100,
    });

    const stale: Array<{ id: string; ai_draft_id: string | null }> = [];
    const drafts: RomanDraftItem[] = [];
    const now = Date.now();
    for (const r of rows) {
      const d = r.ai_draft;
      if (!d || d.status !== 'pending' || (d.expires_at && d.expires_at.getTime() <= now)) continue;
      if (await this.coachRepliedSince(r.client_id, r.source_message.created_at)) {
        stale.push({ id: r.id, ai_draft_id: r.ai_draft_id });
        continue;
      }
      const body = bodyOf(d.payload);
      if (!body) continue;
      const thread = threads.find((t) => t.clientId === r.client_id);
      drafts.push({
        id: r.id,
        draft_id: d.id,
        client: {
          id: r.client_id,
          name: r.client.name ?? '',
          first_name: safeFirstName(r.client.name),
        },
        message: {
          id: r.source_message.id,
          preview: (r.source_message.body ?? '').slice(0, PREVIEW_MAX_CHARS),
          created_at: r.source_message.created_at.toISOString(),
          unread_count: thread?.unread ?? 0,
        },
        reply: body,
        category: asCategory(r.category),
        urgency: asUrgency(r.urgency),
        created_at: r.created_at.toISOString(),
      });
    }
    await this.retire(stale, 'thread_answered_by_coach');

    drafts.sort(
      (a, b) =>
        (URGENCY_RANK[a.urgency ?? 'whenever'] ?? 3) -
          (URGENCY_RANK[b.urgency ?? 'whenever'] ?? 3) ||
        b.message.created_at.localeCompare(a.message.created_at),
    );

    const drafted = new Set(drafts.map((d) => d.client.id));
    const manual: RomanManualReplyItem[] = [];
    for (const t of threads) {
      if (drafted.has(t.clientId)) continue;
      const o = outcomes.get(t.clientId);
      if (o === 'handled') continue;
      const reason: RomanManualReplyItem['reason'] =
        o === 'no_consent'
          ? 'no_ai_consent'
          : o === 'voice_only'
            ? 'voice_only'
            : o === 'failed'
              ? 'draft_failed'
              : o === 'dismissed'
                ? 'draft_dismissed'
                : 'draft_pending';
      manual.push({
        client: { id: t.clientId, name: t.clientName, first_name: safeFirstName(t.clientName) },
        latest_message_at: t.source.created_at.toISOString(),
        unread_count: t.unread,
        reason,
        deep_link: `tgp://messages/${t.clientId}`,
      });
    }
    return { drafts, manual, summary };
  }

  // ── Send / dismiss (the coach's tap) ──────────────────────────────────

  private async loadOwned(coachId: string, id: string) {
    const row = await this.prisma.romanReplyDraft.findFirst({
      where: { id, coach_id: coachId },
      select: {
        id: true,
        client_id: true,
        ai_draft_id: true,
        status: true,
        ai_draft: {
          select: {
            id: true,
            status: true,
            payload: true,
            materialised_ref: true,
            expires_at: true,
            decision_note: true,
          },
        },
      },
    });
    if (!row || !row.ai_draft || !row.ai_draft_id)
      throw new RomanDraftError('reply_draft_not_found');
    return row;
  }

  async send(
    coachId: string,
    id: string,
    input: {
      body?: string;
      idempotencyKey?: string | null;
      ip?: string | null;
      userAgent?: string | null;
    },
  ): Promise<RomanDraftSendResult> {
    const row = await this.loadOwned(coachId, id);
    const draft = row.ai_draft;
    if (!draft || !row.ai_draft_id) throw new RomanDraftError('reply_draft_not_found');
    const original = bodyOf(draft.payload) ?? '';
    if (draft.status === 'approved' && draft.materialised_ref) {
      // Idempotent replay of a send that already happened.
      return {
        status: 'sent',
        id: row.id,
        draft_id: draft.id,
        message_id: draft.materialised_ref,
        edited: false,
      };
    }
    this.assertSendable(draft.status, draft.expires_at, row.status);
    await this.assertDeliverable(coachId, row.client_id);

    let edited = false;
    if (input.body !== undefined) {
      const next = typeof input.body === 'string' ? input.body.trim() : '';
      if (next.length < 1 || next.length > 4000)
        throw new RomanDraftError('reply_draft_body_invalid');
      if (next !== original.trim()) {
        const upd = await this.prisma.aiActionDraft.updateMany({
          where: {
            id: draft.id,
            status: 'pending',
            materialised_at: null,
            tenant_coach_id: coachId,
          },
          data: { payload: { clientId: row.client_id, body: next } },
        });
        if (upd.count === 0) return this.resolveAfterConflict(coachId, id);
        edited = true;
        await this.audit.write({
          action: 'roman.reply_draft_edited',
          actorId: coachId,
          actorRole: 'coach',
          targetType: 'ai_action_draft',
          targetId: draft.id,
          targetUserId: row.client_id,
          tenantCoachId: coachId,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          metadata: {
            original_sha256: sha256(original),
            edited_sha256: sha256(next),
            original_length: original.length,
            edited_length: next.length,
          },
        });
      }
    }

    try {
      await this.approvals.decide({
        draftId: draft.id,
        decider: { id: coachId, role: 'coach' },
        decision: 'approved',
        note: input.idempotencyKey
          ? `roman_reply_draft key=${input.idempotencyKey}`
          : 'roman_reply_draft',
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      });
    } catch (err) {
      const after = await this.prisma.aiActionDraft.findUnique({
        where: { id: draft.id },
        select: { status: true, materialised_ref: true, materialised_at: true },
      });
      if (after?.materialised_ref) {
        return {
          status: 'sent',
          id: row.id,
          draft_id: draft.id,
          message_id: after.materialised_ref,
          edited,
        };
      }
      if (after?.materialised_at) throw new RomanDraftError('reply_draft_send_in_progress');
      if (after && after.status !== 'pending') return this.resolveAfterConflict(coachId, id);
      const ref = draft.id.slice(0, 8);
      this.logger.error(
        `roman reply draft send failed draft=${draft.id} ref=${ref}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new RomanDraftError('reply_draft_send_failed', { reference: ref });
    }
    const sent = await this.prisma.aiActionDraft.findUnique({
      where: { id: draft.id },
      select: { materialised_ref: true },
    });
    if (!sent?.materialised_ref) {
      throw new RomanDraftError('reply_draft_send_failed', { reference: draft.id.slice(0, 8) });
    }
    return {
      status: 'sent',
      id: row.id,
      draft_id: draft.id,
      message_id: sent.materialised_ref,
      edited,
    };
  }

  async dismiss(
    coachId: string,
    id: string,
    meta: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<{ status: 'dismissed'; id: string }> {
    const row = await this.loadOwned(coachId, id);
    const draft = row.ai_draft;
    if (!draft) throw new RomanDraftError('reply_draft_not_found');
    if (draft.status === 'rejected') return { status: 'dismissed', id: row.id };
    if (draft.status === 'approved') throw new RomanDraftError('reply_draft_already_sent');
    if (draft.status !== 'pending') throw new RomanDraftError('reply_draft_expired');
    try {
      await this.approvals.decide({
        draftId: draft.id,
        decider: { id: coachId, role: 'coach' },
        decision: 'rejected',
        note: 'roman_reply_draft_dismissed',
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      });
    } catch {
      const after = await this.prisma.aiActionDraft.findUnique({
        where: { id: draft.id },
        select: { status: true, materialised_at: true },
      });
      if (after?.status === 'rejected') return { status: 'dismissed', id: row.id };
      if (after?.status === 'approved' || after?.materialised_at) {
        throw new RomanDraftError('reply_draft_already_sent');
      }
      throw new RomanDraftError('reply_draft_expired');
    }
    return { status: 'dismissed', id: row.id };
  }

  private assertSendable(status: string, expiresAt: Date | null, claimStatus: string): void {
    if (status === 'approved') throw new RomanDraftError('reply_draft_send_in_progress');
    if (status === 'rejected') throw new RomanDraftError('reply_draft_dismissed');
    if (status !== 'pending' || claimStatus !== 'ready')
      throw new RomanDraftError('reply_draft_expired');
    if (expiresAt && expiresAt.getTime() <= Date.now())
      throw new RomanDraftError('reply_draft_expired');
  }

  /** Specific copy for the two refusals the send path can hit. */
  private async assertDeliverable(coachId: string, clientId: string): Promise<void> {
    const block = await this.prisma.userBlock.findFirst({
      where: {
        OR: [
          { blocker_id: coachId, blocked_id: clientId },
          { blocker_id: clientId, blocked_id: coachId },
        ],
      },
      select: { id: true },
    });
    if (block) throw new RomanDraftError('reply_draft_recipient_blocked');
    const client = await this.prisma.user.findFirst({
      where: { id: clientId, deleted_at: null },
      select: { id: true },
    });
    if (!client) throw new RomanDraftError('reply_draft_client_unavailable');
  }

  private async resolveAfterConflict(coachId: string, id: string): Promise<RomanDraftSendResult> {
    const row = await this.loadOwned(coachId, id);
    const d = row.ai_draft;
    if (d?.status === 'approved' && d.materialised_ref) {
      return {
        status: 'sent',
        id: row.id,
        draft_id: d.id,
        message_id: d.materialised_ref,
        edited: false,
      };
    }
    if (d?.status === 'rejected') throw new RomanDraftError('reply_draft_dismissed');
    if (d?.status === 'pending') throw new RomanDraftError('reply_draft_send_in_progress');
    throw new RomanDraftError('reply_draft_expired');
  }
}

class LeaseLostError extends Error {
  constructor() {
    super('roman reply draft lease lost');
  }
}

function bodyOf(payload: Prisma.JsonValue | null | undefined): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const body = payload.body;
  return typeof body === 'string' && body.trim().length > 0 ? body : null;
}

function asCategory(v: string | null): RomanDraftCategory | null {
  return ROMAN_DRAFT_CATEGORIES.find((c) => c === v) ?? null;
}

function asUrgency(v: string | null): RomanDraftUrgency | null {
  return ROMAN_DRAFT_URGENCIES.find((u) => u === v) ?? null;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
