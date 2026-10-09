import { SetMetadata } from '@nestjs/common';

export const OPEN_TO_COACHLESS_CLIENT_KEY = 'openToCoachlessClient';

/**
 * Open to every client (B23, owner 10-08 14:57 and 15:29; owner 10-08 23:5x:
 * "No reason to ever lock a client from basic functions"). The basic
 * functions on the client's own data: food, water, weight, habit and workout
 * logging, targets, plans, check-ins, fasting, insights and AI guidance. On a route
 * carrying this marker, ClientEntitlementGuard lets every student through
 * without a package lookup: no coach, a coach with a free package, a coach
 * with no package, or a lapsed plan. The name is historical. AI routes keep
 * the coach AI credit pool and the per-client daily cap (ai.service). Places
 * that need a real coach (sessions, voice notes to a coach, the coach's
 * community, coach guidelines, the AI gateway) stay unmarked and keep their
 * 402. The contract in test/coachless-logging-entitlement.spec.ts classifies
 * every controller that mounts the guard. DunningLockoutGuard also lets these
 * routes through during a Day-10 lock, except AI guidance under /ai/*.
 */
export const OpenToCoachlessClient = () => SetMetadata(OPEN_TO_COACHLESS_CLIENT_KEY, true);
