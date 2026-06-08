import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthedRequest } from '../auth/auth-request';
import { COMMUNITY_DISABLED_BODY } from './dto/disabled-response.dto';

export type CommunityFlagState = 'enabled' | 'disabled';

// Marks a handler as "always reachable" — when the flag is off it still runs
// and returns its normal envelope with feature_flag_state: 'disabled'
// (used by /me and /today). Handlers without this marker are gated: the guard
// returns 503 when the flag is off.
export const COMMUNITY_ALWAYS_REACHABLE = 'community_always_reachable';
export const CommunityAlwaysReachable = () =>
  SetMetadata(COMMUNITY_ALWAYS_REACHABLE, true);

export function resolveCommunityFlag(callerId: string): CommunityFlagState {
  const globallyOn = process.env.FEATURE_COMMUNITY_API === 'true';
  const allowlist = (process.env.FEATURE_COMMUNITY_API_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return globallyOn || allowlist.includes(callerId) ? 'enabled' : 'disabled';
}

@Injectable()
export class CommunityFeatureFlagGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const state = resolveCommunityFlag(req.user?.id ?? '');
    req.community_flag_state = state;

    if (state === 'enabled') return true;

    const alwaysReachable = this.reflector.getAllAndOverride<boolean>(
      COMMUNITY_ALWAYS_REACHABLE,
      [context.getHandler(), context.getClass()],
    );
    if (alwaysReachable) return true;

    throw new HttpException(
      COMMUNITY_DISABLED_BODY,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
