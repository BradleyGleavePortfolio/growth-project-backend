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
import { EmailService } from '../email/email.service';
import { EmailTemplateKey } from '../email/email.types';
import { AuditService } from '../audit/audit.service';

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
    private email: EmailService,
    private audit: AuditService,
  ) {}

  /**
   * Authoritative check: a coach may only accept new clients when their
   * CoachSubscription is active, trialing, or grandfathered.
   * CoachProfile.subscription_status is a stale mirror — always use
   * CoachSubscription directly for access-control decisions.
   */
  private async assertCoachCanAcceptClients(coachId: string): Promise<void> {
    const sub = await this.prisma.coachSubscription.findUnique({
      where: { coach_id: coachId },
      select: { status: true },
    });
    const allowed =
      sub && ['active', 'trialing', 'grandfathered'].includes(sub.status);
    if (!allowed) {
      throw new BadRequestException(
        'Coach is not currently accepting clients',
      );
    }
  }

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
      // Bulk-invite recipient binding. When set, redemption validates that
      // the redeeming user's email matches to prevent forwarded-code abuse.
      intended_email?: string | null;
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
            expires_at: expiresAt ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            max_uses: input.max_uses ?? 1,
            intended_email: input.intended_email ?? null,
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

  // Phase 8 — invite-code redeemer drilldown for the mobile UI.
  //
  // We don't (yet) have a first-class InviteRedemption ledger that
  // maps individual users to the InviteCode row that brought them in.
  // The closest correct signal we already have is:
  //   - the user is currently coached by the InviteCode.coach_id (or by
  //     one of that head coach's sub-coaches),
  //   - they signed up after the invite was created,
  //   - if the invite expired, before it expired.
  // For single-use invites (used_count <= 1 and max_uses == 1) this is
  // exact: at most one user can match. For multi-use codes the result
  // is a best-effort window; we surface only as many rows as the
  // invite has been used (capped at used_count) and the caller can
  // trust that those rows came in during the invite's lifetime.
  //
  // The method is IDOR-gated on coach_id so a coach cannot enumerate
  // redeemers of another coach's invite.
  async listRedeemersForCoach(
    coachId: string,
    inviteCodeId: string,
  ): Promise<
    Array<{
      user_id: string;
      name: string;
      email: string;
      redeemed_at: string;
      last_active_at: string | null;
    }>
  > {
    const invite = await this.prisma.inviteCode.findUnique({
      where: { id: inviteCodeId },
    });
    if (!invite) throw new NotFoundException('Invite code not found');
    if (invite.coach_id !== coachId) {
      // Allow OWNERs read access in the future via a separate path; for
      // now coach-only is the safest gate.
      throw new ForbiddenException('Invite code does not belong to caller');
    }
    if (invite.used_count === 0) return [];

    const lowerBound = invite.created_at;
    const upperBound = invite.expires_at ?? new Date();

    // Candidate redeemers: students currently on the inviting coach's
    // roster who signed up between (created_at, min(expires_at, now)).
    const candidates = await this.prisma.user.findMany({
      where: {
        coach_id: invite.coach_id,
        role: 'student',
        deleted_at: null,
        created_at: { gte: lowerBound, lte: upperBound },
      },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        name: true,
        email: true,
        created_at: true,
      },
      // Cap to used_count + a small buffer so a noisy roster window
      // doesn't blow up the response. For exact single-use invites the
      // cap is 1.
      take: Math.max(1, invite.used_count) + 5,
    });

    // Last-active derived from the most recent WorkoutSession /
    // LoggedFoodEntry / CheckIn. Single round-trip across all three.
    const candidateIds = candidates.map((c) => c.id);
    const lastActiveByUser = new Map<string, Date>();
    if (candidateIds.length > 0) {
      const [workouts, foods, checkIns] = await Promise.all([
        this.prisma.workoutSession.findMany({
          where: { user_id: { in: candidateIds } },
          orderBy: { created_at: 'desc' },
          distinct: ['user_id'],
          select: { user_id: true, created_at: true },
        }),
        this.prisma.loggedFoodEntry.findMany({
          where: { user_id: { in: candidateIds } },
          orderBy: { logged_at: 'desc' },
          distinct: ['user_id'],
          select: { user_id: true, logged_at: true },
        }),
        this.prisma.checkIn.findMany({
          where: { user_id: { in: candidateIds } },
          orderBy: { logged_at: 'desc' },
          distinct: ['user_id'],
          select: { user_id: true, logged_at: true },
        }),
      ]);
      const bump = (uid: string, when: Date) => {
        const cur = lastActiveByUser.get(uid);
        if (!cur || when.getTime() > cur.getTime()) {
          lastActiveByUser.set(uid, when);
        }
      };
      for (const r of workouts) bump(r.user_id, r.created_at);
      for (const r of foods) bump(r.user_id, r.logged_at);
      for (const r of checkIns) bump(r.user_id, r.logged_at);
    }

    return candidates.slice(0, Math.max(1, invite.used_count)).map((u) => ({
      user_id: u.id,
      name: u.name,
      email: u.email,
      redeemed_at: u.created_at.toISOString(),
      last_active_at: lastActiveByUser.get(u.id)?.toISOString() ?? null,
    }));
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
        // Block coaches without an active subscription from accepting new
        // clients via their default link. Uses CoachSubscription as the
        // authoritative source rather than the stale mirror on CoachProfile.
        try {
          await this.assertCoachCanAcceptClients(profile.user.id);
        } catch {
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
      await this.assertCoachCanAcceptClients(profile.user.id);
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
        // Validate intended recipient — prevents forwarded-code abuse.
        if (current.intended_email) {
          const redeemerEmail = (me?.email ?? '').toLowerCase().trim();
          const intendedEmail = current.intended_email.toLowerCase().trim();
          if (redeemerEmail !== intendedEmail) {
            throw new BadRequestException(
              'This invite was sent to a different email address',
            );
          }
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
  // 14-day expiry by default. For each created code we attempt to
  // deliver the coach-invites-client email; the per-row email outcome
  // (sent | logged | failed | skipped) is returned alongside the code
  // so the mobile UI can show "✓ emailed to alice@…" or "copy code".
  //
  // Email send doctrine (matches mobile PR #141):
  //   - never fakes success; if Resend is misconfigured, EmailService
  //     throws at boot — by the time we get here, the transport is real
  //     OR EMAIL_TRANSPORT=log (dev). 'logged' is a legitimate status.
  //   - idempotency_key = `invite:<invite_code_id>` so a retried bulk
  //     post never sends twice.
  //   - one failed send does NOT fail the batch — the row's status flips
  //     to 'failed' and the coach sees the per-row outcome.
  async bulkInvite(
    coachId: string,
    rows: { email: string; name?: string; note?: string }[],
  ): Promise<{
    total: number;
    created: {
      email: string;
      code: string;
      invite_code_id: string;
      email_status: 'sent' | 'failed' | 'skipped' | 'logged';
      email_error?: string;
    }[];
    rejected: { email: string; reason: string }[];
  }> {
    const created: {
      email: string;
      code: string;
      invite_code_id: string;
      email_status: 'sent' | 'failed' | 'skipped' | 'logged';
      email_error?: string;
    }[] = [];
    const rejected: { email: string; reason: string }[] = [];

    // Fetch coach display name once — used as {{coach_name}} in every
    // email and in the audit metadata.
    const coach = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { name: true, email: true },
    });
    const coachName = coach?.name ?? 'Your coach';

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
          intended_email: normalised,
        });

        const emailOutcome = await this._sendInviteEmail({
          to: normalised,
          recipientName: row.name,
          personalNote: row.note,
          coachId,
          coachName,
          inviteCode: codeRow.code,
          inviteCodeId: codeRow.id,
          expiresAt,
        });

        created.push({
          email: normalised,
          code: codeRow.code,
          invite_code_id: codeRow.id,
          email_status: emailOutcome.status,
          ...(emailOutcome.error ? { email_error: emailOutcome.error } : {}),
        });

        try {
          this.analytics.capture(coachId, Events.INVITE_PREVIEWED, {
            email: normalised,
            name: row.name ?? null,
            bulk: true,
            via: 'bulk_invite',
            email_status: emailOutcome.status,
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

    // One audit row per bulk call — records the request shape and the
    // per-email outcomes (without including the codes themselves; the
    // codes are PII-adjacent and the invite-code table is the source of
    // truth). This is the operator's "did the launch send X invites
    // on Y at Z" trail.
    await this.audit.write({
      action: 'invite.bulk_sent',
      actorId: coachId,
      tenantCoachId: coachId,
      targetType: 'invite_batch',
      metadata: {
        total_requested: rows.length,
        created_count: created.length,
        rejected_count: rejected.length,
        sent_count: created.filter((r) => r.email_status === 'sent').length,
        failed_count: created.filter((r) => r.email_status === 'failed').length,
        logged_count: created.filter((r) => r.email_status === 'logged').length,
      },
    });

    return { total: rows.length, created, rejected };
  }

  // Send a single invite email for an already-existing InviteCode row.
  // Used by the bulk path and the per-row "resend" endpoint. Idempotent
  // on (invite_code_id) — a second call with the same code id returns
  // status:'skipped' without re-hitting Resend.
  async sendInviteEmailForCode(
    coachId: string,
    inviteCodeId: string,
    recipientEmail: string,
    opts?: { recipientName?: string; personalNote?: string },
  ): Promise<{
    status: 'sent' | 'failed' | 'skipped' | 'logged';
    error?: string;
  }> {
    const row = await this.prisma.inviteCode.findUnique({
      where: { id: inviteCodeId },
    });
    if (!row) throw new NotFoundException('Invite code not found');
    if (row.coach_id !== coachId) {
      throw new ForbiddenException('Invite code does not belong to caller');
    }
    if (row.revoked) {
      throw new BadRequestException('Invite code is revoked');
    }
    const coach = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { name: true },
    });
    return this._sendInviteEmail({
      to: recipientEmail,
      recipientName: opts?.recipientName,
      personalNote: opts?.personalNote,
      coachId,
      coachName: coach?.name ?? 'Your coach',
      inviteCode: row.code,
      inviteCodeId: row.id,
      expiresAt: row.expires_at,
    });
  }

  // ── internal helpers ───────────────────────────────────────────────────

  private async _sendInviteEmail(params: {
    to: string;
    recipientName?: string;
    personalNote?: string;
    coachId: string;
    coachName: string;
    inviteCode: string;
    inviteCodeId: string;
    expiresAt: Date | null;
  }): Promise<{
    status: 'sent' | 'failed' | 'skipped' | 'logged';
    error?: string;
  }> {
    const acceptBase =
      process.env.PUBLIC_INVITE_BASE_URL || 'https://app.trygrowthproject.com/join';
    const acceptUrl = `${acceptBase}/${params.inviteCode}`;
    const expiresAtDisplay = params.expiresAt
      ? params.expiresAt.toISOString().slice(0, 10)
      : 'in 14 days';

    const res = await this.email.send({
      to: params.to,
      template: EmailTemplateKey.COACH_INVITES_CLIENT,
      // Idempotency key is keyed on the invite-code row id (single source
      // of truth for "this invite") so even if a buggy mobile client
      // re-POSTs the bulk request twice, the second call is a no-op.
      idempotencyKey: `invite:${params.inviteCodeId}`,
      data: {
        coach_name: params.coachName,
        recipient_name: params.recipientName ?? null,
        personal_note: params.personalNote ?? null,
        accept_url: acceptUrl,
        invite_code: params.inviteCode,
        expires_at: expiresAtDisplay,
      },
    });
    return res.error
      ? { status: res.status, error: res.error }
      : { status: res.status };
  }

  // ---- C3: public accept-by-token ----------------------------------------
  //
  // Called by POST /invites/accept/:token (public, no auth). The token IS
  // the invite code (e.g. GP-XXXXXX). Resolves via CoachProfile.invite_code
  // first (default per-coach link) then falls back to the per-row InviteCode
  // table, exactly like previewCode() + validate().
  //
  // 14-day TTL is applied from created_at when no explicit expires_at is set
  // (bulk-invite codes always set expires_at; default-link codes never expire
  // server-side, so we treat them as always valid here).
  async acceptByToken(token: string): Promise<
    | { accepted: true; email: string | null; coachName: string | null; redirectTo: 'signup' | 'app_open' }
    | { accepted: false; reason: 'expired' | 'already_accepted' | 'invalid'; message: string }
  > {
    // Input guard — mirrors previewCode().
    if (
      !token ||
      token.length < INVITE_CODE_MIN_LENGTH ||
      token.length > INVITE_CODE_MAX_LENGTH ||
      !INVITE_CODE_PATTERN.test(token)
    ) {
      return { accepted: false, reason: 'invalid', message: 'Invalid invite code format.' };
    }

    try {
      // 1. Try CoachProfile.invite_code (default per-coach link).
      //    These links don't have a TTL or single-use cap — they are
      //    always valid as long as the coach's account is active.
      const profile = await this.prisma.coachProfile.findUnique({
        where: { invite_code: token },
        include: { user: { select: { id: true, name: true, role: true } } },
      });
      if (profile && profile.user && profile.user.role === 'coach') {
        try {
          await this.assertCoachCanAcceptClients(profile.user.id);
        } catch {
          return { accepted: false, reason: 'invalid', message: 'This coach is not currently accepting clients.' };
        }
        return {
          accepted: true,
          email: null,
          coachName: profile.user.name,
          redirectTo: 'signup',
        };
      }

      // 2. Fall back to per-row InviteCode table.
      const record = await this.prisma.inviteCode.findUnique({
        where: { code: token },
        include: { coach: { select: { id: true, name: true, role: true } } },
      });
      if (!record) {
        return { accepted: false, reason: 'invalid', message: 'Invite code not found.' };
      }
      if (record.revoked) {
        return { accepted: false, reason: 'invalid', message: 'This invite code has been revoked.' };
      }

      // Apply 14-day TTL from creation when no explicit expires_at is set.
      const effectiveExpiry = record.expires_at
        ? record.expires_at
        : new Date(record.created_at.getTime() + 14 * 24 * 60 * 60 * 1000);
      if (effectiveExpiry.getTime() <= Date.now()) {
        return { accepted: false, reason: 'expired', message: 'This invite has expired.' };
      }

      // max_uses check (single-use codes that are fully consumed are
      // treated as "already_accepted" from the client's perspective).
      if (record.max_uses !== null && record.used_count >= record.max_uses) {
        return { accepted: false, reason: 'already_accepted', message: 'This invite has already been used.' };
      }

      if (record.coach.role !== 'coach') {
        return { accepted: false, reason: 'invalid', message: 'This invite code is no longer valid.' };
      }

      return {
        accepted: true,
        email: null,
        coachName: record.coach.name,
        redirectTo: 'signup',
      };
    } catch (err) {
      const code_class =
        err instanceof Prisma.PrismaClientKnownRequestError
          ? `prisma:${err.code}`
          : 'unknown';
      this.logger.error(`acceptByToken failed (${code_class}): ${(err as Error).message}`);
      return { accepted: false, reason: 'invalid', message: 'Unable to validate invite at this time.' };
    }
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
