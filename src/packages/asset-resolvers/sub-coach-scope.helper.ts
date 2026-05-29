import { Injectable } from '@nestjs/common';
import { SubCoachScopeService } from '../../sub-coach/sub-coach-scope.service';
import { SubCoachOutOfScopeError } from './assignable-asset-resolver.errors';

// PR-7 — shared sub-coach scope check used by every AssignableAssetResolver.
//
// Per spec + the 50-Failures gate we MUST NOT trust raw `User.coach_id` on
// the client row when materialising as a coach. A sub-coach (role='coach',
// coach_id=headCoachId) is only authorised to act on clients in their
// SubCoachAssignment overlay; the downstream tenant id must be the HEAD
// coach (so existing ownership queries on WorkoutPlan / DailyMealPlan /
// CoachMessage continue to resolve under the right namespace).
//
// All four resolvers funnel through this helper so the rule is enforced in
// exactly one place — adding a new resolver (PR-12+) cannot accidentally
// skip the check.
export interface ResolvedActingCoach {
  /**
   * The tenant owner id to use for downstream lookups. For a head coach
   * this is `inputCoachId` unchanged; for a sub-coach this is the head
   * coach id from `SubCoachScopeService.getHeadCoachIdForSubCoach`.
   */
  tenantCoachId: string;
  /** Echoes the raw acting-coach id (sub or head). */
  actingCoachId: string;
}

@Injectable()
export class ResolverSubCoachScope {
  constructor(private readonly subCoachScope: SubCoachScopeService) {}

  /**
   * Verify that `coachId` is authorised to materialise for `clientId` and
   * return the tenant owner id to use on downstream rows.
   *
   * Throws `SubCoachOutOfScopeError` when the check fails.
   */
  async resolve(
    coachId: string,
    clientId: string,
  ): Promise<ResolvedActingCoach> {
    const allowed = await this.subCoachScope.canAccessClient(
      coachId,
      clientId,
    );
    if (!allowed) {
      throw new SubCoachOutOfScopeError(coachId, clientId);
    }
    const headCoachId =
      await this.subCoachScope.getHeadCoachIdForSubCoach(coachId);
    return {
      tenantCoachId: headCoachId ?? coachId,
      actingCoachId: coachId,
    };
  }
}
