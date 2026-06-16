/**
 * NamedRegimesFeatureGuard — returns 404 on every F2 regime + partial-refund
 * decision route while FEATURE_NAMED_REGIMES is OFF.
 *
 * Applied at the CLASS level on RegimesController and RefundDecisionsController
 * so every handler is hidden as a unit. The controllers stay MOUNTED at all
 * times so the module-graph cycle guard keeps exercising the wiring and the
 * roles-enforced meta-test keeps verifying the class-level @Roles('coach').
 *
 * When the flag is off this guard makes the surface indistinguishable from a
 * non-existent route — a 404, NOT a 403: a hidden feature must look
 * "not found", never leak that it exists. Mirrors MwbTemplatesFeatureGuard.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isNamedRegimesEnabled } from './named-regimes.feature';

@Injectable()
export class NamedRegimesFeatureGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (!isNamedRegimesEnabled()) {
      // 404, not 403 — hide the feature's existence entirely.
      throw new NotFoundException('Not Found');
    }
    return true;
  }
}
