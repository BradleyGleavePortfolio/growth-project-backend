/**
 * MwbTemplatesFeatureGuard — returns 404 on the MWB-2 clone-to-client route
 * while FEATURE_MWB_TEMPLATES is OFF (BUILDER_BRIEF §"Feature flag behavior").
 *
 * The handler stays MOUNTED at all times so the module-graph cycle guard
 * (test/module-graph.spec.ts) keeps exercising the wiring and it never rots.
 * When the flag is off this guard makes the surface indistinguishable from a
 * non-existent route — a 404, NOT a 403 (ENGINEERING_RULES §3: a hidden
 * feature must look "not found", never leak that it exists).
 *
 * Mirrors RomanFeatureGuard (src/roman/roman-feature.guard.ts). The guard is
 * applied at the handler level (not the class) so the existing MWB-1
 * fork/clone/assign routes — which are already live and pinned by
 * test/workout-program-controller-entitlement.spec.ts — are unaffected.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isMwbTemplatesEnabled } from './mwb-templates.feature';

@Injectable()
export class MwbTemplatesFeatureGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (!isMwbTemplatesEnabled()) {
      // 404, not 403 — hide the feature's existence entirely.
      throw new NotFoundException('Cannot POST /workout-programs/:id/clone-to-client');
    }
    return true;
  }
}
