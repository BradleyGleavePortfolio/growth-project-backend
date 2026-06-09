import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { COMMUNITY_DISABLED_BODY } from './dto/disabled-response.dto';

/**
 * v1-3 write kill-switches.
 *
 * v1-2 established CommunityFeatureFlagGuard (the master FEATURE_COMMUNITY_API
 * switch) which gates *every* community route and, for the always-reachable
 * /me + /today, downgrades to a disabled envelope. v1-3 adds three NARROWER,
 * surface-specific switches that ride ON TOP of the master switch:
 *
 *   - FEATURE_COMMUNITY_MESSAGES — cohort-message + post-comment writes
 *   - FEATURE_COMMUNITY_POSTS    — Lab-post writes
 *   - FEATURE_COMMUNITY_DM       — all DM endpoints (read AND write)
 *
 * All three default OFF (execution plan line 248). When a surface flag is OFF
 * the guard throws the SAME typed disabled body the v1-2 kill switch throws,
 * with HTTP 503 (SERVICE_UNAVAILABLE) — identical to
 * CommunityFeatureFlagGuard so clients have ONE disabled contract to handle.
 *
 * Decision (brief §"Feature flags"): three sibling guards rather than one
 * parameterised guard. Sibling classes read cleanly at the @UseGuards site
 * (the route's flag is visible in the decorator list) and keep each surface's
 * kill switch independently greppable, which the moderation invariant relies on
 * — moderation mounts NONE of these, so it can never be silenced by a write
 * flag. The shared resolveWriteFlag() keeps the three classes DRY.
 *
 * Reads the env var with the exactly-'true' convention v1-2 uses
 * (resolveCommunityFlag): absent / any value other than 'true' → OFF.
 */
export function resolveWriteFlag(envVar: string): boolean {
  return process.env[envVar] === 'true';
}

function denyDisabled(): never {
  throw new HttpException(COMMUNITY_DISABLED_BODY, HttpStatus.SERVICE_UNAVAILABLE);
}

export const FEATURE_COMMUNITY_MESSAGES = 'FEATURE_COMMUNITY_MESSAGES';
export const FEATURE_COMMUNITY_POSTS = 'FEATURE_COMMUNITY_POSTS';
export const FEATURE_COMMUNITY_DM = 'FEATURE_COMMUNITY_DM';

/** Gate for message + post-comment WRITE handlers. GETs are never gated. */
@Injectable()
export class CommunityMessagesEnabledGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (resolveWriteFlag(FEATURE_COMMUNITY_MESSAGES)) return true;
    return denyDisabled();
  }
}

/** Gate for Lab-post WRITE handlers. GETs are never gated. */
@Injectable()
export class CommunityPostsEnabledGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (resolveWriteFlag(FEATURE_COMMUNITY_POSTS)) return true;
    return denyDisabled();
  }
}

/** Gate for ALL DM handlers (read AND write) — DM is the sensitive surface. */
@Injectable()
export class CommunityDmEnabledGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (resolveWriteFlag(FEATURE_COMMUNITY_DM)) return true;
    return denyDisabled();
  }
}
