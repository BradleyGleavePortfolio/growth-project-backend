/**
 * Lead-sync queue facade.
 *
 * The repo does not currently ship BullMQ; the project uses
 * @nestjs/schedule for cron-style background work and the
 * CoachLandingLead row's `crm_sync_status` + `@@index([crm_sync_status])`
 * is the durable queue (every pending lead is picked up on the next
 * polling tick, so an in-process crash never loses work).
 *
 * This module exposes `enqueueLeadSync(leadId)` as a thin abstraction so
 * the lead-creation path (landing-pages.public.service.ts) does not need
 * to know whether the underlying transport is "row + cron" today or
 * "BullMQ" tomorrow. When BullMQ is added, only this file changes.
 *
 * Today's implementation: a fire-and-forget kick — the actual claim
 * happens inside LeadSyncProcessor's cron run.  We expose it so:
 *   1. The public lead-create path has an explicit handoff point we can
 *      wrap in try/catch (queue failure must NEVER fail the visitor POST).
 *   2. Tests can stub `enqueueLeadSync` to assert it was called without
 *      booting the whole scheduler.
 */

import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class LeadSyncQueue {
  private readonly logger = new Logger(LeadSyncQueue.name);

  /**
   * Mark a lead for sync.  Today this is a no-op: the cron worker scans
   * `crm_sync_status = 'pending'` so the act of writing the row IS the
   * enqueue.  We keep the call site explicit so a future BullMQ wiring
   * can drop in without touching the public service.
   */
  async enqueue(leadId: string): Promise<void> {
    this.logger.debug(`lead-sync enqueue: ${leadId}`);
  }
}
