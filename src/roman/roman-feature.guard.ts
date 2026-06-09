/**
 * RomanFeatureGuard — returns 404 on every `/roman` route while
 * FEATURE_ROMAN_CHAT_ENABLED is OFF (brief §1.6).
 *
 * The controller stays MOUNTED at all times so the module-graph cycle guard
 * (test/module-graph.spec.ts) keeps exercising it and the wiring never rots.
 * When the flag is off this guard makes the surface indistinguishable from a
 * non-existent route — a 404, not a 403 (ENGINEERING_RULES §3: 404 == "not
 * found or intentionally hidden", never leak that the feature exists).
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isRomanChatEnabled } from './roman.feature';

@Injectable()
export class RomanFeatureGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (!isRomanChatEnabled()) {
      // 404, not 403 — hide the feature's existence entirely.
      throw new NotFoundException('Cannot GET /roman');
    }
    return true;
  }
}
