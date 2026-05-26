/**
 * LeadSyncProcessor — durable CRM fan-out worker.
 *
 * Each tick this scheduler:
 *   1. Claims a batch of `CoachLandingLead` rows with status='pending'
 *      (ordered FIFO via the `(crm_sync_status)` index — older leads
 *      first so a slow CRM does not starve fresh leads in front).
 *   2. For each lead, loads the page + all enabled CrmIntegrations on the
 *      coach, then calls each adapter in parallel via Promise.allSettled.
 *      Parallel fan-out means N CRMs do not serialize behind the slowest.
 *   3. On full success: status='synced', synced_to = providers, external_ids
 *      = { provider → id }, crm_synced_at = now.
 *      On partial success: leave as 'pending', record per-provider errors
 *      on the integration row, and let the next tick retry the failed
 *      providers (idempotent on the provider side since every adapter
 *      upserts by email).  After 3 attempts (tracked via an in-memory
 *      map keyed by lead id), transition to 'failed' so the row stops
 *      polling and the coach can see it in the leads inbox.
 *      On zero integrations: status='skipped'.
 *
 * This design is deliberately resilient to process restarts: the row
 * itself is the queue.  A crash mid-tick leaves the rows in 'pending';
 * the next tick on a fresh boot picks them up.  No Redis dependency.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { CoachLandingLead, CoachLandingPage, CoachCrmIntegration } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { CrmRegistryService } from './crm-registry.service';
import { CoachCrmService } from './crm.service';
import { CrmRateLimitError, CrmAuthError } from './crm-adapter.interface';
import { safeErrorMessage } from './_redact';

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 3;

@Injectable()
export class LeadSyncProcessor {
  private readonly logger = new Logger(LeadSyncProcessor.name);

  /**
   * Per-lead attempt counter.  Survives within a single process; on
   * restart attempts reset to 0 (acceptable — the adapters are
   * email-idempotent so re-pushing is safe).
   */
  private readonly attempts = new Map<string, number>();

  /**
   * Per-lead next-eligible timestamp.  Used to implement exponential
   * backoff (1 min, 5 min, 30 min) without an extra DB column.  A lead
   * whose next-eligible is in the future is skipped this tick.
   */
  private readonly nextEligibleAt = new Map<string, number>();

  /**
   * Per-provider rate-limit cooldown.  When an adapter throws
   * CrmRateLimitError we stop talking to that provider until
   * Retry-After elapses — protects us from getting throttled harder.
   */
  private readonly providerCooldownUntil = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: CrmRegistryService,
    private readonly crm: CoachCrmService,
  ) {}

  /**
   * Cron: every minute. The `crm_sync_status` index keeps the claim
   * scan cheap even at 100k+ leads.
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
    } catch (err) {
      this.logger.error(`lead-sync tick failed: ${safeErrorMessage(err)}`);
    }
  }

  /**
   * Exposed for tests and for the upcoming admin "drain queue" button.
   * Returns the count of leads processed.
   */
  async runOnce(): Promise<number> {
    const now = Date.now();
    const pendingLeads = await this.prisma.coachLandingLead.findMany({
      where: { crm_sync_status: 'pending' },
      orderBy: { created_at: 'asc' },
      take: BATCH_SIZE,
      include: { page: true },
    });
    let processed = 0;
    for (const lead of pendingLeads) {
      const eligibleAt = this.nextEligibleAt.get(lead.id) ?? 0;
      if (eligibleAt > now) continue;
      try {
        await this.processLead(lead, lead.page);
        processed += 1;
      } catch (err) {
        this.logger.error(
          `processLead ${lead.id} threw unexpectedly: ${safeErrorMessage(err)}`,
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
      await this.prisma.coachLandingLead.update({
        where: { id: lead.id },
        data: { crm_sync_status: 'skipped', crm_synced_at: new Date() },
      });
      this.attempts.delete(lead.id);
      this.nextEligibleAt.delete(lead.id);
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
      this.attempts.delete(lead.id);
      this.nextEligibleAt.delete(lead.id);
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
      this.attempts.delete(lead.id);
      this.nextEligibleAt.delete(lead.id);
      return;
    }

    const currentAttempts = (this.attempts.get(lead.id) ?? 0) + 1;
    this.attempts.set(lead.id, currentAttempts);

    if (currentAttempts >= MAX_ATTEMPTS && !anyRateLimited) {
      await this.prisma.coachLandingLead.update({
        where: { id: lead.id },
        data: {
          crm_sync_status: 'failed',
          crm_error: failureReasons.join('; ').slice(0, 1000),
          synced_to: mergedSyncedTo,
          external_ids: externalIds as any,
        },
      });
      this.attempts.delete(lead.id);
      this.nextEligibleAt.delete(lead.id);
      return;
    }

    // Exponential backoff: 1 min, 5 min, 30 min between attempts.  A
    // provider rate-limit cooldown already takes effect via the
    // providerCooldownUntil map.
    const backoffMs =
      currentAttempts === 1 ? 60_000 : currentAttempts === 2 ? 5 * 60_000 : 30 * 60_000;
    this.nextEligibleAt.set(lead.id, Date.now() + backoffMs);
    await this.prisma.coachLandingLead.update({
      where: { id: lead.id },
      data: {
        crm_error: failureReasons.join('; ').slice(0, 1000),
        synced_to: mergedSyncedTo,
        external_ids: externalIds as any,
      },
    });
  }
}
