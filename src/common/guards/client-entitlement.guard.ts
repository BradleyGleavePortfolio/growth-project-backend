import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma.service';
import { SKIP_CLIENT_ENTITLEMENT_KEY } from '../decorators/skip-client-entitlement.decorator';
import { VoicePolicyService } from '../../roman/voice/voice-policy.service';

@Injectable()
export class ClientEntitlementGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    // Phase 2 — the paywall surface. When FEATURE_ROMAN_COPY_V2 is ON the 402
    // body carries the Roman Option-3 paywall copy + avatar crop so the mobile
    // client renders <RomanAvatar /> alongside the plan-picker. VoicePolicyService
    // is @Optional so the existing unit/integration suites that construct the
    // guard with only (prisma, reflector) keep working, and so the flag-OFF body
    // stays byte-for-byte identical to the pre-Phase-2 402 response.
    @Optional() private readonly voice?: VoicePolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is explicitly exempted
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CLIENT_ENTITLEMENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // Only enforce for 'student' role users (clients).
    // Coaches and owners are not subject to client package entitlement.
    if (!user || user.role !== 'student') return true;

    const now = new Date();
    const entitlement = await this.prisma.clientPurchase.findFirst({
      where: {
        client_user_id: user.id,
        entitlement_active: true,
        status: { in: ['paid', 'active', 'trialing'] },
        OR: [
          { access_expires_at: null },
          { access_expires_at: { gt: now } },
        ],
      },
      select: { id: true, status: true, access_expires_at: true },
    });

    if (!entitlement) {
      throw new HttpException(this.paywallBody(), HttpStatus.PAYMENT_REQUIRED); // 402
    }

    return true;
  }

  /**
   * The structured paywall 402 body. The error code + action are stable contract
   * fields the mobile client switches on; only the human-readable `message` and
   * the (additive) `avatar_crop` are voice-policy-aware.
   *
   * Flag OFF (or VoicePolicyService not wired) → byte-for-byte the pre-Phase-2
   * body: { error, message, action } with the original message and NO
   * avatar_crop. Flag ON → the Roman paywall copy as `message` plus the
   * `neutral` avatar crop so the client can render Roman's face.
   */
  private paywallBody(): Record<string, unknown> {
    const base = {
      error: 'CLIENT_ENTITLEMENT_REQUIRED',
      message: 'An active package is required to access this feature.',
      action: 'OPEN_PLANS',
    };

    if (!this.voice) {
      return base;
    }

    const copy = this.voice.copyFor('paywall');
    if (copy.voice_variant !== 'roman_v2') {
      // Flag OFF: preserve the legacy 402 body verbatim (byte-equality).
      return base;
    }

    return {
      ...base,
      message: copy.text,
      avatar_crop: copy.avatar_crop,
    };
  }
}
