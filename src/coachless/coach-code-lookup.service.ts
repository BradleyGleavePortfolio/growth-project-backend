import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { isWellFormedInviteCode } from '../invite-codes/invite-codes.service';
import { COACHLESS_ERROR, type CoachlessErrorCode } from './coachless.errors';
import { publicCoachCardFields } from '../coach/consultation/coach-consultation.vocab';

/** A code resolved to its coach WITHOUT applying lifecycle rules. */
export type ResolvedCoachCode =
  | { kind: 'profile'; code: string; coachId: string; coachRole: string | null }
  | {
      kind: 'row';
      code: string;
      coachId: string;
      coachRole: string | null;
      revoked: boolean;
      expiresAt: Date | null;
      maxUses: number | null;
      usedCount: number;
    };

/** Subscription states that let a coach take new clients (mirrors InviteCodesService). */
export const ACCEPTING_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'trialing',
  'grandfathered',
]);

/**
 * A1-COACHLESS — read-only code lookup shared by the featured-coach config
 * and the redemption route. It never writes and never attaches: the ONE
 * canonical writer stays InviteCodesService.attachUserToCoachByCode.
 *
 * Case: generated codes are upper-case (GP-XXXXXX). The lookup tries the
 * trimmed input exactly first, then its upper-case form, so a client that
 * typed "gp-bradley" resolves to the stored "GP-BRADLEY" while a legacy
 * mixed-case code still resolves exactly.
 */
@Injectable()
export class CoachCodeLookupService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(raw: string): Promise<ResolvedCoachCode | null> {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!isWellFormedInviteCode(trimmed)) return null;
    const exact = await this.resolveExact(trimmed);
    if (exact) return exact;
    const upper = trimmed.toUpperCase();
    return upper === trimmed ? null : this.resolveExact(upper);
  }

  private async resolveExact(code: string): Promise<ResolvedCoachCode | null> {
    const profile = await this.prisma.coachProfile.findUnique({
      where: { invite_code: code },
      select: { user: { select: { id: true, role: true } } },
    });
    if (profile?.user) {
      return {
        kind: 'profile',
        code,
        coachId: profile.user.id,
        coachRole: profile.user.role ?? null,
      };
    }
    const row = await this.prisma.inviteCode.findUnique({
      where: { code },
      select: {
        coach_id: true,
        revoked: true,
        expires_at: true,
        max_uses: true,
        used_count: true,
        coach: { select: { role: true } },
      },
    });
    if (!row) return null;
    return {
      kind: 'row',
      code,
      coachId: row.coach_id,
      coachRole: row.coach?.role ?? null,
      revoked: row.revoked,
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      usedCount: row.used_count,
    };
  }

  /**
   * Why a NEW redemption of this code would be refused, or null when the code
   * is redeemable as far as the code itself goes. Order: unknown/non-coach ->
   * revoked -> expired -> exhausted -> coach subscription.
   */
  async refusalFor(
    resolved: ResolvedCoachCode | null,
    now = new Date(),
  ): Promise<CoachlessErrorCode | null> {
    if (!resolved || resolved.coachRole !== 'coach') return COACHLESS_ERROR.CODE_INVALID;
    if (resolved.kind === 'row') {
      if (resolved.revoked) return COACHLESS_ERROR.CODE_REVOKED;
      if (resolved.expiresAt && resolved.expiresAt.getTime() <= now.getTime())
        return COACHLESS_ERROR.CODE_EXPIRED;
      if (resolved.maxUses !== null && resolved.usedCount >= resolved.maxUses)
        return COACHLESS_ERROR.CODE_EXHAUSTED;
    }
    if (!(await this.coachCanAcceptClients(resolved.coachId)))
      return COACHLESS_ERROR.COACH_NOT_ACCEPTING;
    return null;
  }

  /** CoachSubscription is authoritative (CoachProfile.subscription_status is a stale mirror). */
  async coachCanAcceptClients(coachId: string): Promise<boolean> {
    const sub = await this.prisma.coachSubscription.findUnique({
      where: { coach_id: coachId },
      select: { status: true },
    });
    return !!sub && ACCEPTING_SUBSCRIPTION_STATUSES.has(sub.status);
  }

  /** Public-safe coach card for the attach moment and the banner. */
  async coachCard(coachId: string): Promise<CoachCard | null> {
    const coach = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: {
        id: true,
        name: true,
        role: true,
        profile: { select: { avatar_url: true } },
        coach_profile: { select: { business_name: true, bio: true, headline: true, specialties: true } },
      },
    });
    if (!coach || coach.role !== 'coach') return null;
    return {
      id: coach.id,
      name: coach.name,
      photo_url: coach.profile?.avatar_url ?? null,
      business_name: coach.coach_profile?.business_name ?? null,
      bio: coach.coach_profile?.bio ?? null,
      // COACH-CARD-134: the same card line + specialties as GET /invite/:code/preview.
      ...publicCoachCardFields(coach.coach_profile),
    };
  }
}

export interface CoachCard {
  id: string;
  name: string;
  photo_url: string | null;
  business_name: string | null;
  bio: string | null;
  /** K1 headline, else the K1 bio; null when neither is set. */
  headline: string | null;
  /** K2 specialty keys (known keys only, max five); [] when unset. */
  specialties: string[];
}

/** Unique-constraint violation (Prisma P2002), duck-typed so test doubles qualify. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}
