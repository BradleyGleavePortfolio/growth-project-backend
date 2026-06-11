/**
 * MwbAutosaveUndoFeatureGuard — returns 404 on the MWB-3 autosave + undo routes
 * while FEATURE_MWB_AUTOSAVE_UNDO is OFF (BUILDER_BRIEF §"Feature flag").
 *
 * The handlers stay MOUNTED at all times so the module-graph cycle guard
 * (test/module-graph.spec.ts) keeps exercising the wiring and it never rots.
 * When the flag is off this guard makes the surface indistinguishable from a
 * non-existent route — a 404, NOT a 403 (a hidden feature must look "not found",
 * never leak that it exists). Mirrors MwbTemplatesFeatureGuard
 * (src/workout-builder/mwb-templates-feature.guard.ts).
 *
 * The guard is applied at the handler level so the existing MWB-1/MWB-2 plan
 * routes on the same controller path namespace are unaffected. The service
 * layer re-checks the flag inside every Serializable transaction
 * (defence-in-depth), so this guard is not the only gate.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isMwbAutosaveUndoEnabled } from './workout-builder-autosave.feature';

@Injectable()
export class MwbAutosaveUndoFeatureGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!isMwbAutosaveUndoEnabled()) {
      // 404, not 403 — hide the feature's existence entirely. The message
      // echoes the actual METHOD + path so it is indistinguishable from Nest's
      // own "Cannot <METHOD> <path>" not-found envelope.
      const req = context.switchToHttp().getRequest<{
        method?: string;
        url?: string;
      }>();
      const method = (req.method ?? 'POST').toUpperCase();
      const url = req.url ?? '';
      throw new NotFoundException(`Cannot ${method} ${url}`);
    }
    return true;
  }
}
