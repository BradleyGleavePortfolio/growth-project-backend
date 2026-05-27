/**
 * LeadSyncProcessor — durable CRM fan-out worker.
 *
 * Each tick this scheduler:
 *   1. Claims a batch of `CoachLandingLead` rows whose
 *      crm_sync_status='pending' AND next_eligible_at is null-or-past,
 *      using a single SQL UPDATE … WHERE id IN (SELECT … FOR UPDATE
 *      SKIP LOCKED). This is the multi-replica-safe claim primitive:
 *      two worker pods firing the same tick are guaranteed to walk
 *      disjoint row sets, with no in-memory coordination.
 *   2. For each lead, loads the page + all enabled CrmIntegrations on the
 *      coach, then calls each adapter in parallel via Promise.allSettled.
 *   3. On full success: status='synced', synced_to = providers,
 *      external_ids = { provider → id }, crm_synced_at = now.
 *      On partial success: status returns to 'pending', attempts++,
 *      next_eligible_at = now + backoff (persisted on the row), let
 *      the next tick retry the failed providers (every adapter upserts
 *      by email so re-pushing is idempotent on the provider side).
 *      After MAX_ATTEMPTS, transition to 'failed' so the row stops
 *      polling and the coach can see it in the leads inbox.
 *      On zero integrations: status='skipped' (crm_synced_at left null —
 *      "skipped" is the absence of a sync, not a successful one — see
 *      audit #6 P1-9 numbering note).
 *
 * The row is the queue: the schema-level state (status + attempts +
 * next_eligible_at) is the source of truth. There is no in-memory Map
 * that resets to zero on every restart; a poisoned lead cannot loop
 * forever after a deploy.
 *
 * Audit #6 P1-7 — per-coach outbound rate limit. The processor keeps an
 * in-memory token bucket keyed by coach_id (10 req/sec, burst 20) so a
 * single coach with hundreds of pending leads cannot starve every other
 * coach's CRM (or get TGP IP-banned by HubSpot). Multi-replica caveat:
 * the bucket is per process, so total outbound = N_replicas * 10 req/sec
 * per coach. Acceptable for v1 because the per-provider 429 handling
 * already absorbs the upper bound. A future PR can move this to Redis
 * if the cap becomes a real constraint.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { CoachLandingLead, CoachLandingPage } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { CrmRegistryService } from './crm-registry.service';
import { CoachCrmService } from './crm.service';
import { CrmRateLimitError, CrmAuthError } from './crm-adapter.interface';
import { safeErrorMessage } from './_redact';

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 3;

// ── Per-coach token bucket (P1-7) ───────────────────────────────────────
// Refills at COACH_TOKENS_PER_SECOND, capped at COACH_BUCKET_SIZE. A
// missing entry is treated as a full bucket. We GC any entries older
// than 1 hour each tick so coaches who stop ever syncing leave no
// memory pressure.
const COACH_TOKENS_PER_SECOND = 10;
const COACH_BUCKET_SIZE = 20;
const COACH_BUCKET_GC_MS = 60 * 60 * 1_000;

interface CoachBucket {
  tokens: number;
  updatedAtMs: number;
}

@Injectable()
export class LeadSyncProcessor {
  private readonly logger = new Logger(LeadSyncProcessor.name);

  /**
   * Per-provider rate-limit cooldown.  When an adapter throws
   * CrmRateLimitError we stop talking to that provider until
   * Retry-After elapses — protects us from getting throttled harder.
   */
  private readonly providerCooldownUntil = new Map<string, number>();

  /** Audit #6 P1-7 — per-coach outbound rate limit. */
  private readonly coachBuckets = new Map<string, CoachBucket>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: CrmRegistryService,
    private readonly crm: CoachCrmService,
  ) {}

  /**
   * Cron: every minute. The `(crm_sync_status, next_eligible_at)`
   * composite index keeps the claim scan cheap even at 100k+ leads.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'crm-lead-sync', timeZone: 'UTC' })
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    if (process.env.CRM_LEAD_SYNC_DISABLED === 'true') return;
    try {
      const processed = await this.runOnce();
      if (processed > 0) {
        this.logger.log(`lead-sync tick: processed ${processed} leads`);
      }
      this.gcCoachBuckets();
    } catch (err) {
      this.logger.error(`lead-sync tick failed: ${safeErrorMessage(err)}`);
    }
  }

  /**
   * Exposed for tests and for the upcoming admin "drain queue" button.
   * Returns the count of leads processed.
   *
   * Audit #6 P0-6 — multi-replica-safe claim. We issue a single
   * UPDATE … SET crm_sync_status='syncing' … RETURNING * whose target
   * rows are selected via FOR UPDATE SKIP LOCKED. Postgres guarantees
   * two concurrent claims will return disjoint sets. The transition
   * away from 'pending' also makes the row invisible to other replicas
   * even if their SELECT raced ours (the WHERE clause re-checks the
   * status inside the same UPDATE).
   */
  async runOnce(): Promise<number> {
    const claimed = await this.prisma.$queryRawUnsafe<
      Array<CoachLandingLead & { page: CoachLandingPage | null }>
    >(
      `
      WITH next AS (
        SELECT id FROM "CoachLandingLead"
         WHERE crm_sync_status = 'pending'
           AND (next_eligible_at IS NULL OR next_eligible_at <= NOW())
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      UPDATE "CoachLandingLead" l
         SET crm_sync_status = 'syncing'
        FROM next
       WHERE l.id = next.id
       RETURNING l.*
      `,
      BATCH_SIZE,
    );

    if (claimed.length === 0) return 0;

    // Bulk-load the pages in one query rather than N joins. claim ids
    // are guaranteed distinct (primary key), so the page set is small.
    const pageIds = Array.from(new Set(claimed.map((l) => l.page_id)));
    const pages = await this.prisma.coachLandingPage.findMany({
      where: { id: { in: pageIds } },
    });
    const pageById = new Map(pages.map((p) => [p.id, p]));

    let processed = 0;
    for (const lead of claimed) {
      const page = pageById.get(lead.page_id);
      if (!page) {
        // Page deleted between insert and claim — drop the lead in
        // 'failed' so it doesn't loop. Practically this only happens
        // when an admin force-removes a page.
        await this.prisma.coachLandingLead.update({
          where: { id: lead.id },
          data: {
            crm_sync_status: 'failed',
            crm_error: 'source page deleted',
          },
        });
        continue;
      }
      try {
        await this.processLead(lead, page);
        processed += 1;
      } catch (err) {
        this.logger.error(
          `processLead ${lead.id} threw unexpectedly: ${safeErrorMessage(err)}`,
        );
        // Return the row to 'pending' with attempts++ and a backoff so
        // a thrown exception doesn't leave it stuck in 'syncing'.
        await this.returnToPendingWithBackoff(
          lead.id,
          lead.attempts,
          'unexpected error',
        );
      }
    }
    return processed;
  }

  private async processLead(
    lead: CoachLandingLead,
    page: CoachLandingPage,
  ): Promise<void> {
    const integrations = await this.crm.loadAllEnabledForCoach(page.coach_id);
    if (integrations.length === 0) {
      // Audit #6 P1-9 — "skipped" is the absence of a sync, not a
      // successful one. Leaving crm_synced_at null means the inbox UI
      // can distinguish "no CRM connected" from "synced at 14:02".
      await this.prisma.coachLandingLead.update({
        where: { id: lead.id },
        data: { crm_sync_status: 'skipped' },
      });
      return;
    }

    const alreadySynced = new Set(lead.synced_to);
    const externalIds: Record<string, string> = {
      ...((lead.external_ids as Record<string, string> | null) ?? {}),
    };
    const todo = integrations.filter((i) => !alreadySynced.has(i.row.provider));
    if (todo.length === 0) {
      await this.prisma.coachLandingLead.update({
        where: { id: lead.id },
        data: {
          crm_sync_status: 'synced',
          crm_synced_at: new Date(),
          crm_error: null,
        },
      });
      return;
    }

    // Audit #6 P1-7 — per-coach rate limit. Consume up to one token
    // per provider call this lead requires. If the bucket is empty
    // return the lead to 'pending' with a short retry instead of
    // calling the CRM and getting throttled.
    if (!this.tryConsumeCoachTokens(page.coach_id, todo.length)) {
      this.logger.warn(
        `coach ${page.coach_id} hit per-coach rate limit; deferring lead ${lead.id}`,
      );
      await this.returnToPendingWithBackoff(lead.id, lead.attempts, 'rate-limited');
      return;
    }

    const now = Date.now();
    const results = await Promise.allSettled(
      todo.map(async ({ row, config }) => {
        const cooldownUntil = this.providerCooldownUntil.get(row.provider) ?? 0;
        if (cooldownUntil > now) {
          throw new Error(`provider ${row.provider} in cooldown`);
        }
        const adapter = this.registry.getAdapter(row.provider);
        return { row, result: await adapter.pushLead(lead, page, config) };
      }),
    );

    const succeeded: string[] = [];
    const failureReasons: string[] = [];
    let anyRateLimited = false;

    for (let i = 0; i < results.length; i += 1) {
      const integration = todo[i];
      const outcome = results[i];
      if (outcome.status === 'fulfilled') {
        succeeded.push(integration.row.provider);
        externalIds[integration.row.provider] = outcome.value.result.external_id;
        await this.crm.recordIntegrationResult(integration.row.id, { ok: true });
      } else {
        const err = outcome.reason;
        if (err instanceof CrmRateLimitError) {
          anyRateLimited = true;
          this.providerCooldownUntil.set(
            integration.row.provider,
            Date.now() + err.retryAfterMs,
          );
        }
        const reason =
          err instanceof CrmAuthError
            ? `auth failed (${err.provider})`
            : safeErrorMessage(err);
        failureReasons.push(`${integration.row.provider}: ${reason}`);
        await this.crm.recordIntegrationResult(integration.row.id, {
          ok: false,
          error: reason,
        });
      }
    }

    const mergedSyncedTo = Array.from(
      new Set<string>([...alreadySynced, ...succeeded]),
    );

    if (failureReasons.length === 0) {
      await this.prisma.coachLandingLead.update({
        where: { id: lead.id },
        data: {
          crm_sync_status: 'synced',
          crm_synced_at: new Date(),
          crm_error: null,
          synced_to: mergedSyncedTo,
          external_ids: externalIds as any,
        },
      });
      return;
    }

    const nextAttempts = lead.attempts + 1;

    if (nextAttempts >= MAX_ATTEMPTS && !anyRateLimited) {
      await this.prisma.coachLandingLead.update({
        where: { id: lead.id },
        data: {
          crm_sync_status: 'failed',
          crm_error: failureReasons.join('; ').slice(0, 1000),
          synced_to: mergedSyncedTo,
          external_ids: externalIds as any,
          attempts: nextAttempts,
        },
      });
      return;
    }

    // Exponential backoff: 1 min, 5 min, 30 min between attempts.  A
    // provider rate-limit cooldown already takes effect via the
    // providerCooldownUntil map.
    const backoffMs =
      nextAttempts === 1 ? 60_000 : nextAttempts === 2 ? 5 * 60_000 : 30 * 60_000;
    await this.prisma.coachLandingLead.update({
      where: { id: lead.id },
      data: {
        crm_sync_status: 'pending',
        crm_error: failureReasons.join('; ').slice(0, 1000),
        synced_to: mergedSyncedTo,
        external_ids: externalIds as any,
        attempts: nextAttempts,
        next_eligible_at: new Date(Date.now() + backoffMs),
      },
    });
  }

  /**
   * Return a claimed lead to 'pending' with attempts++ and a short
   * (60s) backoff. Used for unexpected throws and per-coach rate-limit
   * deferrals so the row never gets stuck in 'syncing'.
   */
  private async returnToPendingWithBackoff(
    leadId: string,
    currentAttempts: number,
    reason: string,
  ): Promise<void> {
    const nextAttempts = currentAttempts + 1;
    await this.prisma.coachLandingLead.update({
      where: { id: leadId },
      data: {
        crm_sync_status: 'pending',
        attempts: nextAttempts,
        next_eligible_at: new Date(Date.now() + 60_000),
        crm_error: reason.slice(0, 1000),
      },
    }).catch((err) => {
      this.logger.error(
        `returnToPendingWithBackoff failed for ${leadId}: ${safeErrorMessage(err)}`,
      );
    });
  }

  // ── Per-coach token bucket helpers (Audit #6 P1-7) ────────────────────

  private tryConsumeCoachTokens(coachId: string, n: number): boolean {
    const nowMs = Date.now();
    const existing = this.coachBuckets.get(coachId);
    let tokens = COACH_BUCKET_SIZE;
    if (existing) {
      const elapsedSec = Math.max(0, (nowMs - existing.updatedAtMs) / 1000);
      tokens = Math.min(
        COACH_BUCKET_SIZE,
        existing.tokens + elapsedSec * COACH_TOKENS_PER_SECOND,
      );
    }
    if (tokens < n) {
      // Partial refill update so we don't recompute from scratch later.
      this.coachBuckets.set(coachId, { tokens, updatedAtMs: nowMs });
      return false;
    }
    this.coachBuckets.set(coachId, {
      tokens: tokens - n,
      updatedAtMs: nowMs,
    });
    return true;
  }

  private gcCoachBuckets(): void {
    const cutoff = Date.now() - COACH_BUCKET_GC_MS;
    for (const [coachId, bucket] of this.coachBuckets) {
      if (bucket.updatedAtMs < cutoff) {
        this.coachBuckets.delete(coachId);
      }
    }
  }
}
