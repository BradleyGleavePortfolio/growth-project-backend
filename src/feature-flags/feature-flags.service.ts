import { Injectable } from '@nestjs/common';
import type { AppRole } from '../common/decorators/roles.decorator';
import { resolveCommunityFlag } from '../community/community-feature-flag.guard';
import {
  FEATURE_FLAG_KEYS,
  type FeatureFlagKey,
} from './feature-flags.dto';

/**
 * D5 = B+γ — server-side feature-flag evaluation.
 *
 * The single source of truth for the flag values delivered to the mobile
 * client by `GET /me/feature-flags`. Each flag is resolved per-request from an
 * environment gate (never boot-cached) so a runtime kill takes effect without
 * a redeploy — matching the convention the community kill-switch guards already
 * use (resolveCommunityFlag / resolveClassroomFlag).
 *
 * This service does NOT re-implement env parsing for the community master
 * switch: it delegates to `resolveCommunityFlag` (the existing guard helper),
 * so the flag map can never report a community feature as ON for a caller who
 * cannot reach community at all. The per-feature env vars below are read the
 * same way the individual community kill-switch guards read theirs.
 *
 * Evaluation is O(1) per request — a fixed number of `process.env` reads and an
 * allowlist membership check inside resolveCommunityFlag. No DB access, no N+1.
 */

/** Inputs needed to evaluate flags for a caller. */
export interface FlagEvaluationContext {
  userId: string;
  role: AppRole;
}

/** A boolean env gate parsed with the repo's literal-'true' convention. */
function envOn(name: string): boolean {
  return process.env[name] === 'true';
}

@Injectable()
export class FeatureFlagsService {
  /**
   * Resolve every exposed flag for the caller. The returned object's keys are
   * exactly FEATURE_FLAG_KEYS (the controller relies on this completeness so
   * the client never sees a missing flag).
   */
  evaluate(ctx: FlagEvaluationContext): Record<FeatureFlagKey, boolean> {
    // Community master gate (FEATURE_COMMUNITY_API + per-caller allowlist).
    // A community-scoped feature can only be ON if the caller can reach
    // community at all — mirrors the server-side guard chain.
    const communityReachable =
      resolveCommunityFlag(ctx.userId) === 'enabled';

    // Wearable prompts are a COACH surface (server gates the authoring with
    // @Roles('coach','owner')); a student must always read it as OFF so the
    // mobile client never renders the coach-only prompt entry point.
    const isCoachOrOwner = ctx.role === 'coach' || ctx.role === 'owner';

    return {
      community_search:
        communityReachable && envOn('FEATURE_COMMUNITY_SEARCH'),
      coach_community_wearable_prompts:
        communityReachable &&
        isCoachOrOwner &&
        envOn('FEATURE_COMMUNITY_WEARABLE_PROMPTS'),
      community_classroom:
        communityReachable && envOn('FEATURE_COMMUNITY_CLASSROOM_POSTS'),
      community_events:
        communityReachable && envOn('FEATURE_COMMUNITY_EVENTS'),
    };
  }

  /** The stable list of flag keys this service evaluates. */
  get flagKeys(): readonly FeatureFlagKey[] {
    return FEATURE_FLAG_KEYS;
  }
}
