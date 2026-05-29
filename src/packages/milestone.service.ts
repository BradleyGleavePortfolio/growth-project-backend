import { Injectable, Logger } from '@nestjs/common';
import { DripTriggerService } from './drip-trigger.service';

// PR-11 — MilestoneService.
//
// Minimal "named-milestone emit" seam. The repo did NOT previously have
// a generic milestone bus — it had MilestoneReachedEmitter (notification
// side-effect only, in src/notifications/emitters/milestone-reached.emitter.ts)
// and per-feature PTM signals (workout_logged, finance_milestone, etc.)
// that are decoupled from packages. PR-11 introduces a thin emit() seam
// that drives the on_milestone drip trigger.
//
// Live milestone keys (the only ones currently wired in this repo)
// ---------------------------------------------------------------
//   - 'build_week_complete'  — fired when a buyer finishes the 7-day
//                              Build Week arc. Hooked in
//                              BuildWeekService.completeDay on the
//                              final day's success path. See
//                              src/build-week/build-week.service.ts.
//
// Adding more keys later is intentionally just "find an existing real
// completion signal in another service and call milestone.emit(...)
// from it." We deliberately did NOT pre-define a milestone-key
// taxonomy — keys are free-form strings whose meaning lives entirely
// in the coach's authoring choice (cadence_payload.milestone_key) and
// the emit call site. Coaches can attach an on_milestone drop with
// any key string; only keys with a matching emit() call site will
// actually fire. This is consistent with the brief's "do not build a
// speculative milestone taxonomy" rule.

@Injectable()
export class MilestoneService {
  private readonly logger = new Logger(MilestoneService.name);

  constructor(private readonly trigger: DripTriggerService) {}

  /**
   * Emit a named milestone for a buyer. Fire-and-forget — the caller
   * must NEVER let a milestone emit failure bubble back into the
   * legitimate user-facing operation (completing a workout, hitting a
   * weight goal, etc.). DripTriggerService.onMilestone itself never
   * throws, but the additional belt-and-braces wrap here protects
   * against future regressions.
   *
   * The string milestoneKey matches the cadence_payload.milestone_key
   * coaches set when attaching an on_milestone CoachPackageContent.
   * Unknown keys are a NO-OP (a coach may have attached an
   * on_milestone drop for a key no service emits — eventually
   * delivered when a future emit site is added, or never if the key
   * was a typo; in either case nothing breaks).
   */
  async emit(buyerUserId: string, milestoneKey: string): Promise<void> {
    if (!buyerUserId || !milestoneKey) {
      this.logger.warn(
        `MilestoneService.emit ignored: buyerUserId=${buyerUserId} milestoneKey=${milestoneKey}`,
      );
      return;
    }
    try {
      await this.trigger.onMilestone({ buyerUserId, milestoneKey });
    } catch (err) {
      this.logger.warn(
        `MilestoneService.emit threw despite trigger guard for buyer=${buyerUserId} key=${milestoneKey}: ${(err as Error).message}`,
      );
    }
  }
}
