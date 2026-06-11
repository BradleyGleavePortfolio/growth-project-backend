/**
 * WorkoutBuilderRevisionPruneCron — MWB-3 revision GC (spec §5.2, operator
 * decision C: retain 30 revisions per plan).
 *
 * Runs every 6 hours. For each plan whose WorkoutPlanRevision count exceeds the
 * retention limit, it delegates to
 * WorkoutBuilderAutosaveService.pruneRevisionsForPlan(), which (in its own
 * Serializable transaction) deletes the OLDEST revisions until exactly 30
 * remain, NEVER deleting the current head_revision_id and NEVER deleting a
 * revision younger than 24h (the rapid-fire safety net). Each plan that loses
 * rows emits a PostHog `mwb_autosave_revision_pruned { plan_id, deleted_count }`.
 *
 * Feature flag: the cron self-checks FEATURE_MWB_AUTOSAVE_UNDO and NO-OPS when
 * off (the service methods it calls also self-check, so the flag is enforced at
 * both layers — R0: no silent prune while the feature is dark). The cron stays
 * REGISTERED at all times so the wiring never rots.
 *
 * Resilience: a failure pruning one plan is logged and never aborts the run for
 * the remaining plans (one bad plan must not stall the whole GC). The handler
 * never throws — @nestjs/schedule would otherwise leave an unhandled rejection.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { isMwbAutosaveUndoEnabled } from './workout-builder-autosave.feature';
import { WorkoutBuilderAutosaveService } from './workout-builder-autosave.service';

@Injectable()
export class WorkoutBuilderRevisionPruneCron {
  private readonly logger = new Logger(WorkoutBuilderRevisionPruneCron.name);

  constructor(
    private readonly autosave: WorkoutBuilderAutosaveService,
  ) {}

  // Every 6 hours on the hour (00:00, 06:00, 12:00, 18:00 UTC). Named so the
  // scheduler registry stays legible alongside the other standing crons.
  @Cron('0 */6 * * *', {
    name: 'workout-builder-revision-prune',
    timeZone: 'UTC',
  })
  async handlePrune(): Promise<void> {
    if (!isMwbAutosaveUndoEnabled()) {
      // Flag OFF (default): no-op. Logged at debug so an operator can confirm
      // the cron is alive but intentionally idle.
      this.logger.debug(
        'FEATURE_MWB_AUTOSAVE_UNDO off — revision prune skipped',
      );
      return;
    }

    this.logger.log('Starting MWB-3 revision prune sweep');
    let planIds: string[];
    try {
      planIds = await this.autosave.findPlanIdsExceedingRetention();
    } catch (err) {
      this.logger.error(
        `Revision prune sweep failed to enumerate plans: ${(err as Error).message}`,
        (err as Error).stack,
      );
      return;
    }

    let totalDeleted = 0;
    let prunedPlans = 0;
    for (const planId of planIds) {
      try {
        const deleted = await this.autosave.pruneRevisionsForPlan(planId);
        if (deleted > 0) {
          totalDeleted += deleted;
          prunedPlans += 1;
        }
      } catch (err) {
        // One bad plan must not stall the sweep (R0: no silent whole-run abort).
        this.logger.error(
          `Revision prune failed for plan ${planId}: ${(err as Error).message}`,
          (err as Error).stack,
        );
      }
    }

    this.logger.log(
      `MWB-3 revision prune sweep complete: ${prunedPlans} plan(s) pruned, ` +
        `${totalDeleted} revision(s) deleted`,
    );
  }
}
