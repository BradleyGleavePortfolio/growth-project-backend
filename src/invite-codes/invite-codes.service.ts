import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  // Phase 1C imports retained when previewCode/attachUserToCoachByCode are
  // exercised below.
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma.service';

type ValidationSuccess = {
  valid: true;
  coach_id: string;
  coach_name: string;
  invite_code_id: string;
};
type ValidationFailure = { valid: false; reason: string };
export type ValidationResult = ValidationSuccess | ValidationFailure;

// Unambiguous alphabet — no 0/O, 1/I/L — so codes read unambiguously over the
// phone or in handwriting. 32 chars × 6 = 2^30 combinations, plenty for the
// foreseeable code volume.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const CODE_PREFIX = 'GP-';
const MAX_GENERATION_ATTEMPTS = 10;

// Public format constants surfaced via /auth/signup-policy so the mobile
// client can validate input before round-tripping. Server-side DTOs (and the
// controller's polished format guard on /auth/validate-invite-code) enforce
// the same bounds, so any drift is a one-line fix here.
export const INVITE_CODE_PREFIX = CODE_PREFIX;
export const INVITE_CODE_MIN_LENGTH = 3;
export const INVITE_CODE_MAX_LENGTH = 32;
// Whitespace-trimmed, case-insensitive shape check. Letters, digits, and
// dashes only. Mobile mirrors this to gate input before POST.
export const INVITE_CODE_PATTERN = /^[A-Za-z0-9-]+$/;

@Injectable()
export class InviteCodesService {
  private readonly logger = new Logger(InviteCodesService.name);

  constructor(private prisma: PrismaService) {}

  // Generates a human-friendly `GP-XXXXXX` code. Retries on the (astronomically
  // unlikely) unique-collision so callers never see a spurious 500.
  private generateCode(): string {
    const bytes = randomBytes(CODE_LENGTH);
    let out = CODE_PREFIX;
    for (let i = 0; i < CODE_LENGTH; i++) {
      out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;
  }

  async createForCoach(
    coachId: string,
    input: { expires_at?: string; max_uses?: number },
  ) {
    const expiresAt = input.expires_at ? new Date(input.expires_at) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw new BadRequestException('Invalid expires_at');
    }
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('expires_at must be in the future');
    }

    // Retry loop for the (extremely rare) unique-index collision on `code`.
    // Prisma throws P2002 on unique violation; anything else bubbles.
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      const code = this.generateCode();
      try {
        return await this.prisma.inviteCode.create({
          data: {
            code,
            coach_id: coachId,
            expires_at: expiresAt,
            max_uses: input.max_uses ?? null,
          },
        });
      } catch (err: any) {
        if (err?.code === 'P2002') {
          this.logger.warn(`invite code collision on ${code}, retrying`);
          continue;
        }
        throw err;
      }
    }
    // Astronomically unlikely: 10 consecutive collisions against a 30-bit space.
    throw new InternalServerErrorException('Could not generate a unique invite code');
  }

  async listForCoach(coachId: string) {
    return this.prisma.inviteCode.findMany({
      where: { coach_id: coachId },
      orderBy: { created_at: 'desc' },
    });
  }

  async revokeForCoach(coachId: string, inviteCodeId: string) {
    const existing = await this.prisma.inviteCode.findUnique({
      where: { id: inviteCodeId },
    });
    if (!existing) throw new NotFoundException('Invite code not found');
    // IDOR guard: a coach can only revoke their own codes.
    if (existing.coach_id !== coachId) {
      throw new ForbiddenException('Invite code does not belong to caller');
    }
    return this.prisma.inviteCode.update({
      where: { id: inviteCodeId },
      data: { revoked: true },
    });
  }

  // Shared validation used by both the public endpoint and the signup wire-up.
  // Returns a structured result rather than throwing so the caller can choose
  // the right HTTP shape (public endpoint returns {valid:false}; signup wants 400).
  async validate(code: string): Promise<ValidationResult> {
    const record = await this.prisma.inviteCode.findUnique({
      where: { code },
      include: { coach: { select: { id: true, name: true, role: true } } },
    });
    if (!record) return { valid: false, reason: 'not_found' };
    if (record.revoked) return { valid: false, reason: 'revoked' };
    if (record.expires_at && record.expires_at.getTime() <= Date.now()) {
      return { valid: false, reason: 'expired' };
    }
    if (record.max_uses !== null && record.used_count >= record.max_uses) {
      return { valid: false, reason: 'max_uses_reached' };
    }
    // Defensive: only a coach-role user should be able to claim students. If a
    // coach was later demoted, refuse to honor their codes.
    if (record.coach.role !== 'coach') {
      return { valid: false, reason: 'coach_inactive' };
    }
    return {
      valid: true,
      coach_id: record.coach.id,
      coach_name: record.coach.name,
      invite_code_id: record.id,
    };
  }

  // ---- Phase 1C: default per-coach invite link ----------------------
  //
  // CoachProfile carries a single human-friendly `invite_code` that the
  // coach can hand out without bookkeeping (vs. the multi-row InviteCode
  // table which supports expirations and per-code use limits). These two
  // helpers cover the "default link" flow:
  //
  //   - getOrCreateDefaultForCoach: lazy-create on first read. Idempotent.
  //   - regenerateDefaultForCoach: rotate the code (e.g. coach suspects
  //     leakage). Old code stops resolving immediately.
  //
  // Both use a generation/retry loop on the unique constraint.

  async getOrCreateDefaultForCoach(coachId: string) {
    const existing = await this.prisma.coachProfile.findUnique({
      where: { user_id: coachId },
    });
    if (existing) return existing;

    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.coachProfile.create({
          data: {
            user_id: coachId,
            invite_code: this.generateCode(),
          },
        });
      } catch (err: any) {
        if (err?.code === 'P2002') continue;
        throw err;
      }
    }
    throw new InternalServerErrorException(
      'Could not generate a unique invite code',
    );
  }

  async regenerateDefaultForCoach(coachId: string) {
    await this.getOrCreateDefaultForCoach(coachId);
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.coachProfile.update({
          where: { user_id: coachId },
          data: { invite_code: this.generateCode() },
        });
      } catch (err: any) {
        if (err?.code === 'P2002') continue;
        throw err;
      }
    }
    throw new InternalServerErrorException(
      'Could not generate a unique invite code',
    );
  }

  // ---- Phase 1C: public preview / validation ------------------------
  //
  // Resolves a code (CoachProfile.invite_code OR InviteCode.code) into a
  // safe coach preview: name, business name, branding accents. No PII
  // beyond what a client would see on the signup screen anyway.
  //
  // Returns `{valid:false}` with no leak if the code does not resolve,
  // is revoked, or the coach is not currently in good standing.
  async previewCode(code: string): Promise<
    | {
        valid: true;
        coach_id: string;
        coach_name: string;
        business_name: string | null;
        branding: { accent_color: string | null; logo_url: string | null };
      }
    | { valid: false }
  > {
    // 1. Try CoachProfile.invite_code first (default per-coach link).
    const profile = await this.prisma.coachProfile.findUnique({
      where: { invite_code: code },
      include: {
        user: { select: { id: true, name: true, role: true } },
      },
    });
    if (profile && profile.user && profile.user.role === 'coach') {
      // Block paused/canceled coaches from accepting new clients via
      // their default link. `subscription_status` is null until Stripe
      // is wired up, so null is treated as "still good standing" for
      // backwards compat.
      if (
        profile.subscription_status === 'canceled' ||
        profile.subscription_status === 'paused'
      ) {
        return { valid: false };
      }
      return {
        valid: true,
        coach_id: profile.user.id,
        coach_name: profile.user.name,
        business_name: profile.business_name,
        branding: {
          accent_color: profile.branding_accent_color,
          logo_url: profile.branding_logo_url,
        },
      };
    }

    // 2. Fall back to legacy InviteCode rows.
    const validation = await this.validate(code);
    if (!validation.valid) return { valid: false };
    return {
      valid: true,
      coach_id: validation.coach_id,
      coach_name: validation.coach_name,
      business_name: null,
      branding: { accent_color: null, logo_url: null },
    };
  }

  // ---- Phase 1C: link / attach existing user to a coach -------------
  //
  // Used after a client signs in via Google (no invite_code on the
  // initial OAuth roundtrip) and then enters the coach's invite code
  // from the post-OAuth screen. Atomic + idempotent — also used by the
  // `signup-with-code` flow once the user record exists.
  async attachUserToCoachByCode(userId: string, code: string) {
    // Resolve to a coach_id, regardless of whether the code is a
    // CoachProfile default code or a legacy InviteCode row.
    const profile = await this.prisma.coachProfile.findUnique({
      where: { invite_code: code },
      include: { user: { select: { id: true, role: true } } },
    });

    let resolvedCoachId: string | null = null;
    let inviteCodeRowId: string | null = null;

    if (profile && profile.user?.role === 'coach') {
      if (
        profile.subscription_status === 'canceled' ||
        profile.subscription_status === 'paused'
      ) {
        throw new BadRequestException('Coach is not currently accepting clients');
      }
      resolvedCoachId = profile.user.id;
    } else {
      const v = await this.validate(code);
      if (!v.valid) throw new BadRequestException('Invalid or expired invite code');
      resolvedCoachId = v.coach_id;
      inviteCodeRowId = v.invite_code_id;
    }

    // OWNERs do not get coached.
    const me = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!me) throw new NotFoundException('User not found');
    if (me.role === 'owner') {
      throw new ForbiddenException('Owners cannot redeem a coach invite');
    }

    // Atomic linkage + (if applicable) used_count bump.
    return this.prisma.$transaction(async (tx) => {
      if (inviteCodeRowId) {
        const current = await tx.inviteCode.findUnique({ where: { id: inviteCodeRowId } });
        if (!current || current.revoked) {
          throw new BadRequestException('Invalid or expired invite code');
        }
        if (current.expires_at && current.expires_at.getTime() <= Date.now()) {
          throw new BadRequestException('Invalid or expired invite code');
        }
        if (current.max_uses !== null && current.used_count >= current.max_uses) {
          throw new BadRequestException('Invalid or expired invite code');
        }
        const bumped = await tx.inviteCode.updateMany({
          where: {
            id: inviteCodeRowId,
            revoked: false,
            used_count: current.used_count,
          },
          data: { used_count: { increment: 1 } },
        });
        if (bumped.count !== 1) {
          throw new BadRequestException('Invalid or expired invite code');
        }
      }

      const updated = await tx.user.update({
        where: { id: userId },
        data: { role: 'student', coach_id: resolvedCoachId },
      });
      return { role: updated.role, coach_id: updated.coach_id };
    });
  }
}
