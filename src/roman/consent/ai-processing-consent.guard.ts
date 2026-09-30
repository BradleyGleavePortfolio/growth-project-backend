/**
 * AiProcessingConsentGuard — route-level enforcement of the AI processing
 * consent for endpoints OUTSIDE the Roman controller that still send client
 * data to a third-party model. Today that is `POST /ai/chat` (AI Guide),
 * which keeps running until R7 retires it (plan §6.2 "the same guard on
 * /ai/chat while it lives").
 *
 * Throws the same structured 403 ROMAN_CONSENT_REQUIRED as the Roman send
 * path so the mobile app has exactly one code to react to.
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
