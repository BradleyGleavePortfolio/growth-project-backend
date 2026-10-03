import { Injectable } from '@nestjs/common';
import { SubCoachScopeService } from '../sub-coach/sub-coach-scope.service';

export interface CoachScope {
  /** The caller (head coach or sub-coach). */
  actorId: string;
  /** Head coach id: the tenant and the CoachMessage thread namespace. */
  tenantId: string;
  /** Clients the caller may message (live students only). */
  clientIds: string[];
}

/**
 * Single place that answers "whose roster is this caller allowed to reach".
 * Reuses SubCoachScopeService (the same rule the command center and the
 * 1:1 messaging path use), so a sub-coach reaches only assigned clients and
 * every row is written under the head coach's tenant id.
 */
@Injectable()
export class BroadcastScopeService {
  constructor(private readonly subCoachScope: SubCoachScopeService) {}

  async resolve(actorId: string): Promise<CoachScope> {
    const [clientIds, head] = await Promise.all([
      this.subCoachScope.getAuthorizedClientIds(actorId),
      this.subCoachScope.getHeadCoachIdForSubCoach(actorId),
    ]);
    return { actorId, tenantId: head ?? actorId, clientIds };
  }
}
