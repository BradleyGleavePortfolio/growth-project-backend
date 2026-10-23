import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
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
   * `tx` (FX-JOIN): the purchase transaction. A paid join, a code join or a
   * guest checkout writes the client's coach in it, so the check reads there.
   *
   * Throws `SubCoachOutOfScopeError` when the check fails.
   */
  async resolve(
    coachId: string,
    clientId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ResolvedActingCoach> {
    if (!(await this.allowed(coachId, clientId, tx))) {
      throw new SubCoachOutOfScopeError(coachId, clientId);
    }
    const headCoachId =
      await this.subCoachScope.getHeadCoachIdForSubCoach(coachId);
    return {
      tenantCoachId: headCoachId ?? coachId,
      actingCoachId: coachId,
    };
  }

  /**
   * FX-JOIN: true when only `tx` lets `coachId` act for `clientId` (an attach
   * written earlier in `tx`, not committed yet). A delegate that checks scope
   * and writes on its own connection (sendAsCoach, assignPlan) cannot see it,
   * so that drop waits for the drip dispatcher, which runs after the commit.
   */
  async onlyInTx(
    coachId: string,
    clientId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    if (!tx || (await this.allowed(coachId, clientId))) return false;
    return this.allowed(coachId, clientId, tx);
  }

  private async allowed(coachId: string, clientId: string, tx?: Prisma.TransactionClient): Promise<boolean> {
    const s = this.subCoachScope;
    if (await (tx ? s.canAccessClient(coachId, clientId, tx) : s.canAccessClient(coachId, clientId))) return true;
    // COACH-GONE-DELIVERY: a deleted coach's paid drop still reaches its buyer, nobody else.
    const gone = tx ? s.deliversForGoneCoach?.(coachId, clientId, tx) : s.deliversForGoneCoach?.(coachId, clientId);
    return (await gone) === true;
  }
}
