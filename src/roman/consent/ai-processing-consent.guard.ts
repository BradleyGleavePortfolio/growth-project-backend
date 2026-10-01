/**
 * AiProcessingConsentGuard — route-level enforcement of the client's AI
 * processing consent (the combined onboarding grant, current version only).
 * Mounted on `POST /roman/sessions/:id/messages`, the only route that sends
 * user data to a model, in addition to the in-handler assert. `/ai/chat` is
 * retired (410) and no longer needs it.
 *
 * Throws the structured 403 ROMAN_CONSENT_REQUIRED the mobile app keys on.
 * Fails closed: no user, no row, revoked, or stale version → 403.
 */

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { AuthedRequest } from '../../auth/auth-request';
import { RomanConsentService } from './roman-consent.service';

@Injectable()
export class AiProcessingConsentGuard implements CanActivate {
  constructor(private readonly consent: RomanConsentService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const userId = req.user?.id;
    if (!userId) return false;
    await this.consent.assertAiConsent(userId);
    return true;
  }
}
