// B-AIBSUB-126 — Ask AI (the AI workout builder) is hidden for sub-coaches at launch. A sub-coach's plans are not in the
// head coach's tenant scope the generator uses, and a draft stamped with the head coach's tenant cannot be decided by the
// sub-coach, so every Ask AI attempt would dead-end. v1.1: plan scope via the autosave `authorisePlanAccess` gate.
import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { SubCoachScopeService } from '../../../sub-coach/sub-coach-scope.service';

type Caller = { id: string; role: string };

/** True when `caller` is a coach whom `getHeadCoachIdForSubCoach` maps to another (head) coach. Owners and head/solo coaches: false. */
export async function isSubCoachOfAnotherCoach(
  scope: Pick<SubCoachScopeService, 'getHeadCoachIdForSubCoach'>,
  caller: Caller,
): Promise<boolean> {
  if (caller.role !== 'coach') return false;
  const head = await scope.getHeadCoachIdForSubCoach(caller.id);
  return head !== null && head !== caller.id;
}

/**
 * Runs after JwtAuthGuard and RolesGuard. A sub-coach gets the exact 404 of a route this backend never mounted (what an
 * older backend answers), so the app hides the Ask AI entry the same way it does on an older backend.
 */
@Injectable()
export class WorkoutBuilderNoSubCoachGuard implements CanActivate {
  constructor(private readonly scope: SubCoachScopeService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: Caller }>();
    if (req.user && (await isSubCoachOfAnotherCoach(this.scope, req.user))) {
      throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl ?? req.url}`);
    }
    return true;
  }
}
