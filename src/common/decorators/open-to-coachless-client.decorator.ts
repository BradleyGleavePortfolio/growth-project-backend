import { SetMetadata } from '@nestjs/common';

export const OPEN_TO_COACHLESS_CLIENT_KEY = 'openToCoachlessClient';

/**
 * B23 (owner 10-08 14:57 and 15:29): a client with no coach uses everything a
 * coached client uses on their own data: food, water and workout logging,
 * targets, plans, check-ins, fasting, insights and AI guidance. On a route
 * carrying this marker, ClientEntitlementGuard lets a student whose
 * `coach_id` is null through without a paid package. A client attached to a
 * coach still needs active access here. Places that need a real coach
 * (sessions, voice notes to a coach, the coach's community, coach guidelines,
 * the AI gateway) stay unmarked and keep their 402. The contract in
 * test/coachless-logging-entitlement.spec.ts classifies every controller that
 * mounts the guard.
 */
export const OpenToCoachlessClient = () => SetMetadata(OPEN_TO_COACHLESS_CLIENT_KEY, true);
