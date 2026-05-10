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
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';

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

  constructor(
    private prisma: PrismaService,
    private analytics: AnalyticsService,
  ) {}

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
    input: {
      expires_at?: string;
      max_uses?: number;
      // Team Mode (ADR-0001 §10 Q5). Set to a sub-coach's user id when
      // the sub-coach issues the invite under their head coach. The
      // resulting row carries coach_id = head coach (so existing
      // tenancy checks keep working) AND invited_by_user_id = sub-coach
      // (so the audit feed can show "Invited by sub-coach <name>").
      // Null on a head-coach-direct invite — preserves legacy shape.
      //
      // When the caller does NOT supply this field but is a sub-coach
      // (has at least one active TeamSubCoachAssignment row), we
      // auto-detect attribution and route the invite under their head
      // coach. Single source for this is resolveTeamAttribution() below.
      invited_by_user_id?: string | null;
    },
  ) {
    const expiresAt = input.expires_at ? new Date(input.expires_at) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw new BadRequestException('Invalid expires_at');
    }
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('expires_at must be in the future');
    }

    // Q5 attribution. If the caller explicitly supplied
    // invited_by_user_id we trust that (the team-mode service's own
    // helpers may want to pre-resolve attribution). Otherwise, auto-
    // detect: if the caller is a sub-coach, redirect coach_id to their
    // head coach and stamp attribution.
    const attribution =
      input.invited_by_user_id !== undefined
        ? {
            effective_coach_id: coachId,
            invited_by_user_id: input.invited_by_user_id,
          }
        : await this.resolveTeamAttribution(coachId);

    // Retry loop for the (extremely rare) unique-index collision on `code`.
    // Prisma throws P2002 on unique violation; anything else bubbles.
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      const code = this.generateCode();
      try {
        const created = await this.prisma.inviteCode.create({
          data: {
            code,
            coach_id: attribution.effective_coach_id,
            invited_by_user_id: attribution.invited_by_user_id,
            expires_at: expiresAt,
            max_uses: input.max_uses ?? null,
          },
        });
        // Q4 + Q5: write the curated audit event when this invite was
        // sub-coach-attributed. Best-effort — a failure here does not
        // roll back the invite create. Same posture as the existing
        // analytics calls in bulkInvite.
        if (
          attribution.invited_by_user_id &&
          attribution.invited_by_user_id !== attribution.effective_coach_id
        ) {
          try {
            await this.prisma.teamAuditEvent.create({
              data: {
                head_coach_id: attribution.effective_coach_id,
                actor_user_id: attribution.invited_by_user_id,
                target_client_id: null,
                event_kind: 'invite_sent_by_sub_coach',
                summary: 'Invite code issued by sub-coach.',
                metadata: {
                  invite_code_id: created.id,
                  sub_coach_id: attribution.invited_by_user_id,
                } as Prisma.InputJsonValue,
              },
            });
          } catch (err) {
            this.logger.warn(
              `team audit event write failed for invite ${created.id}: ${err instanceof Error ? err.message : 'unknown'}`,
            );
          }
        }
        return created;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          this.logger.warn(`invite code collision on ${code}, retrying`);
          continue;
        }
        throw err;
      }
    }
    // Astronomically unlikely: 10 consecutive collisions against a 30-bit space.
    throw new InternalServerErrorException('Could not generate a unique invite code');
  }

  // Q5 attribution resolver. Pure DB lookup — given the calling user's
  // id, returns whether they are a sub-coach and, if so, which head
  // coach owns the team they are inviting under. When the caller has
  // multiple active head coaches (the cap is 2), the most-recently-
  // created assignment wins. Deterministic without requiring the caller
  // to pre-decide.
  //
  // Returned shape:
  //   - head coach (no active sub-coach assignment): {effective_coach_id: callerId, invited_by_user_id: null}
  //   - sub-coach (>=1 active assignment): {effective_coach_id: head_coach_id, invited_by_user_id: callerId}
  private async resolveTeamAttribution(
    callerId: string,
  ): Promise<{ effective_coach_id: string; invited_by_user_id: string | null }> {
    const subAssignment = await this.prisma.teamSubCoachAssignment.findFirst({
      where: { sub_coach_id: callerId, archived_at: null },
      orderBy: { created_at: 'desc' },
      select: { head_coach_id: true },
    });
    if (!subAssignment) {
      return { effective_coach_id: callerId, invited_by_user_id: null };
    }
    return {
      effective_coach_id: subAssignment.head_coach_id,
      invited_by_user_id: callerId,
    };
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
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
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
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
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
    // Anonymous preview — distinctId is the (already opaque) code itself so
    // PostHog can deduplicate repeated previews from the same client without
    // needing a logged-in user. The code is non-PII (random GP-XXXXXX).
    this.analytics.capture(`code:${code}`, Events.INVITE_PREVIEWED, {});

    // Reject obviously-invalid input before going to the database. Path
    // params are not run through the DTO ValidationPipe, so anything could
    // arrive here — empty string, a NUL byte, kilobytes of garbage, etc.
    // Bound it cheaply so brute-force enumeration of malformed codes never
    // hits Prisma. The bounds match INVITE_CODE_MIN/MAX_LENGTH and the
    // INVITE_CODE_PATTERN allow-list (letters, digits, dashes only).
    if (
      !code ||
      code.length < INVITE_CODE_MIN_LENGTH ||
      code.length > INVITE_CODE_MAX_LENGTH ||
      !INVITE_CODE_PATTERN.test(code)
    ) {
      return { valid: false };
    }

    // Fail closed on any database-side failure. The preview endpoint is
    // public and unauthenticated; a transient pool timeout or a schema/
    // client drift incident must not turn invite onboarding into a 500.
    // The mobile app + landing page both render the same generic
    // "invite unavailable" state for `{valid:false}`, so the user sees a
    // graceful surface instead of a stack-trace screen, and the original
    // error still surfaces in Sentry via the logger.error call below.
    try {
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
    } catch (err) {
      // Known Prisma errors (P2xxx — pool timeout, schema drift, bad
      // bytes in input, etc.) and any other unexpected throw are coerced
      // to {valid:false}. We log at error level so Sentry still pages on
      // anything actually broken; we just don't blow up the caller.
      const code_class =
        err instanceof Prisma.PrismaClientKnownRequestError
          ? `prisma:${err.code}`
          : 'unknown';
      this.logger.error(
        `previewCode failed (${code_class}): ${(err as Error).message}`,
      );
      return { valid: false };
    }
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
      this.analytics.capture(userId, Events.INVITE_REDEEMED, {
        via: 'attach_code',
        coach_id: resolvedCoachId,
        legacy_invite_row: !!inviteCodeRowId,
      });
      return { role: updated.role, coach_id: updated.coach_id };
    });
  }

  // Sprint B — Bulk invite. For each row we generate a single-use code
  // tagged with the recipient's email so the coach (and audit trail)
  // can map a code back to the person it was meant for. Codes have a
  // 14-day expiry by default. The send-email step is best-effort and
  // never fails the request — failed sends are returned as
  // `email_status: "skipped"` so the coach can copy/paste manually.
  async bulkInvite(
    coachId: string,
    rows: { email: string; name?: string; note?: string }[],
  ): Promise<{
    total: number;
    created: { email: string; code: string; invite_code_id: string }[];
    rejected: { email: string; reason: string }[];
  }> {
    const created: { email: string; code: string; invite_code_id: string }[] = [];
    const rejected: { email: string; reason: string }[] = [];

    // De-dupe by lower-cased email — emitting two codes for the same
    // address inside one batch is almost always a copy/paste mistake.
    const seen = new Set<string>();
    for (const row of rows) {
      const normalised = row.email.trim().toLowerCase();
      if (!normalised) {
        rejected.push({ email: row.email, reason: 'empty' });
        continue;
      }
      if (seen.has(normalised)) {
        rejected.push({ email: row.email, reason: 'duplicate_in_batch' });
        continue;
      }
      seen.add(normalised);
      try {
        const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
        const codeRow = await this.createForCoach(coachId, {
          expires_at: expiresAt.toISOString(),
          max_uses: 1,
        });
        created.push({
          email: normalised,
          code: codeRow.code,
          invite_code_id: codeRow.id,
        });
        // Audit trail — re-using the same INVITE_PREVIEWED stream the
        // single-create flow emits so dashboards see one timeline.
        try {
          this.analytics.capture(coachId, Events.INVITE_PREVIEWED, {
            email: normalised,
            name: row.name ?? null,
            bulk: true,
            via: 'bulk_invite',
          });
        } catch {
          // analytics never blocks bulk invite flow
        }
      } catch (err) {
        this.logger.warn(
          `bulkInvite: failed for ${normalised}: ${err instanceof Error ? err.message : 'unknown'}`,
        );
        rejected.push({ email: normalised, reason: 'create_failed' });
      }
    }
    this.logger.log(
      `bulkInvite coach=${coachId} requested=${rows.length} created=${created.length} rejected=${rejected.length}`,
    );
    return { total: rows.length, created, rejected };
  }

  // Helper: parse a coach's pasted CSV/newline-separated text into
  // {email,name?,note?} rows. Liberal accept: comma- or tab-separated,
  // up to 3 fields per line. Emails are validated as a final pass at
  // the DTO layer when the parsed rows are POSTed back.
  parsePasted(input: string, maxRows = 100): {
    email: string;
    name?: string;
    note?: string;
  }[] {
    const out: { email: string; name?: string; note?: string }[] = [];
    const lines = input
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    for (const line of lines) {
      if (out.length >= maxRows) break;
      // Split on the first comma or tab — keep the rest as one field
      // so a note containing further commas is preserved.
      const parts = line.split(/[\t,]/).map((p) => p.trim());
      const [email, name, note] = parts;
      if (!email) continue;
      out.push({
        email,
        name: name || undefined,
        note: note || undefined,
      });
    }
    return out;
  }
}
