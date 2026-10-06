import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  // Phase 1C imports retained when previewCode/attachUserToCoachByCode are
  // exercised below.
} from '@nestjs/common';
import { randomInt } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { EmailService } from '../email/email.service';
import { EmailTemplateKey } from '../email/email.types';
import { AuditService } from '../audit/audit.service';
import { InviteGrantService, type GrantOutcome } from '../invite-grant/invite-grant.service';

type ValidationSuccess = {
  valid: true;
  coach_id: string;
  coach_name: string;
  invite_code_id: string;
};
type ValidationFailure = { valid: false; reason: string };
export type ValidationResult = ValidationSuccess | ValidationFailure;

// Unambiguous alphabet — no 0/O, 1/I/L — so codes read unambiguously over the
// phone or in handwriting. 31 chars × 6 positions = 31^6 ≈ 8.9×10^8
// combinations, plenty for the foreseeable code volume.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const CODE_PREFIX = 'GP-';
const MAX_GENERATION_ATTEMPTS = 10;
// AUDIT-17-125 — most redeemers listed for one code ("Who joined").
const REDEEMERS_LIMIT = 500;

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

// Stateless `GP-XXXXXX` candidate generator shared with AuthService (C13
// signup-time coach provisioning mints the CoachProfile.invite_code inside
// the signup transaction, where the retry-on-P2002 loop below cannot run).
// Same alphabet/length as the private `generateCode` so codes are
// indistinguishable from lazily-created ones. `crypto.randomInt` is uniform
// over the alphabet (the previous `byte % 31` was slightly biased —
// CodeQL js/biased-cryptographic-random).
export function generateInviteCodeCandidate(): string {
  let out = CODE_PREFIX;
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

// Clinic C13 fix round — shared with AuthService.selectRole and the C03 attach
// error table: INVITE_ATTACH_ERROR.COACH_CANNOT_REDEEM is this constant and the
// attach path throws coachCannotRedeemBody(), so select-role and attach return
// the same `{ code, message }` (ErrorEnvelope shape) and mobile can branch
// without parsing prose.
export const INVITE_ATTACH_COACH_CANNOT_REDEEM = 'coach_cannot_redeem' as const;

/** Roles that own a tenant (or a seat in one) and must never be re-parented
 *  or demoted by a client invite code / storefront purchase. */
export const COACH_LIKE_ROLES: ReadonlySet<string> = new Set(['coach', 'sub_coach', 'owner']);

export function isCoachLikeRole(role: string | null | undefined): boolean {
  return !!role && COACH_LIKE_ROLES.has(role);
}

export function coachCannotRedeemBody(): { code: typeof INVITE_ATTACH_COACH_CANNOT_REDEEM; message: string } {
  return {
    code: INVITE_ATTACH_COACH_CANNOT_REDEEM,
    message:
      'Coach accounts cannot redeem a client invite code. Your role was fixed when the account was created; ask the platform owner if it needs to change.',
  };
}


/**
 * True when `value` is a well-formed invite code (shape only — no DB lookup).
 * Shared by the DTO validators, the signup throttler burst rule and the attach
 * path so "looks like a code" means the same thing everywhere.
 */
export function isWellFormedInviteCode(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (
    trimmed.length >= INVITE_CODE_MIN_LENGTH &&
    trimmed.length <= INVITE_CODE_MAX_LENGTH &&
    INVITE_CODE_PATTERN.test(trimmed)
  );
}

// Clinic launch C03 — machine-readable reasons for a failed invite attach.
// Every exception thrown by attachUserToCoachByCode carries one of these in
// its response body (`{ code, message }`, the ErrorEnvelope convention) so the
// auth flows can surface `invite_attach_error` to mobile instead of silently
// swallowing the failure. Codes are safe to show a client: they never echo
// the code string, the coach id or the intended email.
export const INVITE_ATTACH_ERROR = {
  /** Code unknown, revoked, expired, exhausted, or failed the seat race. */
  INVITE_CODE_INVALID: 'invite_code_invalid',
  /** Coach subscription not active/trialing/grandfathered. */
  COACH_NOT_ACCEPTING_CLIENTS: 'coach_not_accepting_clients',
  /** Redeemer is already a client of a DIFFERENT coach; refuse to re-parent. */
  ALREADY_ATTACHED_TO_DIFFERENT_COACH: 'already_attached_to_different_coach',
  /** Single-recipient invite redeemed by a different email. */
  INVITE_INTENDED_EMAIL_MISMATCH: 'invite_intended_email_mismatch',
  /** Owners are never coached. */
  OWNER_CANNOT_REDEEM: 'owner_cannot_redeem',
  /** Coach / sub_coach accounts are never coached and are NEVER demoted (the C13 constant, not a copy). */
  COACH_CANNOT_REDEEM: INVITE_ATTACH_COACH_CANNOT_REDEEM,
  /** Redeemer row not found. */
  USER_NOT_FOUND: 'user_not_found',
  /** Anything else (DB error, timeout). */
  ATTACH_FAILED: 'attach_failed',
  /**
   * A2 coach code tools — the code exists but its coach turned it off
   * (revoke, or a rotation without a grace period). Specific copy: ask the
   * coach for their current code. Only a NEW redemption sees these three; a
   * client already attached to that coach gets the idempotent replay.
   */
  CODE_REVOKED: 'code_revoked',
  /** A2 — the code passed its expiry (including the end of a rotation grace period). */
  CODE_EXPIRED: 'code_expired',
  /** A2 — the code reached its signup limit (max_uses). */
  CODE_EXHAUSTED: 'code_exhausted',
} as const;
export type InviteAttachErrorCode = (typeof INVITE_ATTACH_ERROR)[keyof typeof INVITE_ATTACH_ERROR];

const INVITE_ATTACH_ERROR_CODES: ReadonlySet<string> = new Set(Object.values(INVITE_ATTACH_ERROR));

/** Extract the safe reason code from an attach failure; unknown → attach_failed. */
export function inviteAttachErrorCode(err: unknown): InviteAttachErrorCode {
  if (err instanceof HttpException) {
    const body = err.getResponse();
    if (body && typeof body === 'object') {
      const code = (body as { code?: unknown }).code;
      if (typeof code === 'string' && INVITE_ATTACH_ERROR_CODES.has(code)) {
        return code as InviteAttachErrorCode;
      }
    }
  }
  return INVITE_ATTACH_ERROR.ATTACH_FAILED;
}

/**
 * Thrown INSIDE the attach transaction when the conditional user update
 * (coach_id IS NULL AND role = 'student') lost a race to a sibling request
 * that attached the same user to the SAME coach. Rolls the seat bump back
 * and is converted to an idempotent `already_attached: true` result.
 */
class AttachRaceSameCoach extends Error {
  constructor(readonly coachId: string) {
    super('attach race: same coach');
  }
}

/** B-658-7 — the coach link the caller saw is no longer current: answer with that rotation's outcome. */
class LinkAlreadyRotated extends Error {}

function linkRotationConflict(): ConflictException {
  return new ConflictException({
    code: 'code_rotation_conflict',
    message: 'Your coach link was just changed on another device. Refresh your codes to see the current link.',
  });
}

/** Only students can be attached to a coach; every other role is refused, never rewritten. */
function assertRedeemerIsStudent(me: { role: string }): void {
  if (me.role === 'student') return;
  if (me.role === 'owner') {
    throw new ForbiddenException({
      code: INVITE_ATTACH_ERROR.OWNER_CANNOT_REDEEM,
      message: 'Owners cannot redeem a coach invite',
    });
  }
  // Same body as /auth/select-role (C13): says what happened and what to do next.
  throw new ForbiddenException(coachCannotRedeemBody());
}

function invalidInviteCode(): BadRequestException {
  return new BadRequestException({
    code: INVITE_ATTACH_ERROR.INVITE_CODE_INVALID,
    message: 'Invalid or expired invite code',
  });
}

/**
 * A2 — a refusal for a code that EXISTS but cannot take a new signup, with a
 * reason the client can act on. The code was already resolved to a real
 * coach before this runs, so naming the lifecycle state leaks nothing a
 * typed-in code had not already proven; unknown codes stay
 * `invite_code_invalid`. Copy says what happened and what to do next.
 */
export function inviteCodeLifecycleRefusal(reason: string | null | undefined): BadRequestException {
  switch (reason) {
    case 'revoked':
      return new BadRequestException({
        code: INVITE_ATTACH_ERROR.CODE_REVOKED,
        message:
          'This code was turned off by the coach who shared it. Ask your coach for their current code.',
      });
    case 'expired':
      return new BadRequestException({
        code: INVITE_ATTACH_ERROR.CODE_EXPIRED,
        message: 'This code has expired. Ask your coach for a new one.',
      });
    case 'max_uses_reached':
      return new BadRequestException({
        code: INVITE_ATTACH_ERROR.CODE_EXHAUSTED,
        message: 'This code has reached its signup limit. Ask your coach for a new one.',
      });
    default:
      return invalidInviteCode();
  }
}

/** Lifecycle state of an InviteCode row for a NEW redemption (null = usable). */
export function inviteCodeRowLifecycle(
  row: { revoked: boolean; expires_at: Date | null; max_uses: number | null; used_count: number },
  now: number = Date.now(),
): 'revoked' | 'expired' | 'max_uses_reached' | null {
  if (row.revoked) return 'revoked';
  if (row.expires_at && row.expires_at.getTime() <= now) return 'expired';
  if (row.max_uses !== null && row.used_count >= row.max_uses) return 'max_uses_reached';
  return null;
}

/** Grant outcome attached to an attach result (C01). */
export type AttachGrant = Omit<GrantOutcome, 'purchase_id'> & {
  purchase_id: string | null;
  package_id: string | null;
};

/** Result of the canonical attach. `grant` is absent when the code carries no package. */
export type AttachResult = {
  role: string;
  coach_id: string | null;
  already_attached: boolean;
  grant?: AttachGrant | null;
};

@Injectable()
export class InviteCodesService {
  private readonly logger = new Logger(InviteCodesService.name);

  constructor(
    private prisma: PrismaService,
    private analytics: AnalyticsService,
    private email: EmailService,
    private audit: AuditService,
    // Clinic C01 — optional so existing 4-arg constructions (tests, scripts)
    // keep working; when absent, codes never grant packages.
    @Optional() private readonly grants?: InviteGrantService,
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
    const allowed = sub && ['active', 'trialing', 'grandfathered'].includes(sub.status);
    if (!allowed) {
      throw new BadRequestException({
        code: INVITE_ATTACH_ERROR.COACH_NOT_ACCEPTING_CLIENTS,
        message: 'Coach is not currently accepting clients',
      });
    }
  }

  // Generates a human-friendly `GP-XXXXXX` code. Retries on the (astronomically
  // unlikely) unique-collision so callers never see a spurious 500.
  private generateCode(): string {
    return generateInviteCodeCandidate();
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
  async resolveTeamAttribution(
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

  // Phase 8 — invite-code redeemer drilldown for the mobile UI ("Who
  // joined"), read from the InviteRedemption ledger (AUDIT-17-125). The
  // method is IDOR-gated on coach_id so a coach cannot enumerate
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
    // AUDIT-17-125 — the signup ledger (one row per new redemption), not a
    // signup-time window guess; accepted_by_user_id covers a pre-ledger first
    // redeemer. Only students still on this coach's roster are shown.
    const ledger = await this.prisma.inviteRedemption.findMany({
      where: { invite_code_id: invite.id, coach_id: invite.coach_id },
      orderBy: { redeemed_at: 'asc' },
      select: { client_user_id: true, redeemed_at: true },
      take: REDEEMERS_LIMIT,
    });
    const redeemedAt = new Map<string, Date>();
    for (const r of ledger) {
      if (!redeemedAt.has(r.client_user_id)) redeemedAt.set(r.client_user_id, r.redeemed_at);
    }
    if (invite.accepted_by_user_id && !redeemedAt.has(invite.accepted_by_user_id)) {
      redeemedAt.set(invite.accepted_by_user_id, invite.accepted_at ?? invite.created_at);
    }
    if (redeemedAt.size === 0) return [];
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: [...redeemedAt.keys()] },
        coach_id: invite.coach_id,
        role: 'student',
        deleted_at: null,
      },
      select: { id: true, name: true, email: true },
    });
    const candidates = users
      .map((u) => ({ ...u, redeemed_at: redeemedAt.get(u.id) ?? invite.created_at }))
      .sort((a, b) => a.redeemed_at.getTime() - b.redeemed_at.getTime());

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

    return candidates.map((u) => ({
      user_id: u.id,
      name: u.name,
      email: u.email,
      redeemed_at: u.redeemed_at.toISOString(),
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
      // A2 — stamp when it was turned off (kept if it was already revoked).
      data: { revoked: true, revoked_at: existing.revoked_at ?? new Date() },
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
    const lifecycle = inviteCodeRowLifecycle(record);
    if (lifecycle) return { valid: false, reason: lifecycle };
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
    throw new InternalServerErrorException('Could not generate a unique invite code');
  }

  async regenerateDefaultForCoach(coachId: string) {
    return (await this.rotateDefaultCode(coachId, 0)).profile;
  }

  /**
   * A2 — rotate the coach's permanent link code. The new code replaces it on
   * CoachProfile and the OLD code is archived as an InviteCode row in the
   * same transaction, so it keeps resolving to this coach:
   *   - graceMs = 0: archived revoked, so a new signup with it gets the
   *     specific `code_revoked` refusal instead of a bare "invalid code";
   *   - graceMs > 0: archived active until now + graceMs (unlimited uses),
   *     then `code_expired`. Signups inside the window still attach.
   * The archived row copies the package binding so a signup during the grace
   * window gets the same package. Clients already attached are untouched:
   * User.coach_id is the durable link, and a replay of the old code by an
   * attached client stays the idempotent `already_attached` success.
   * B-658-7: with `expectedCode` (the link the caller saw) a retry, or an
   * overlapping duplicate, of a rotation that already happened writes nothing
   * and returns that rotation's successor (`successor_code` on the archived row).
   */
  async rotateDefaultCode(
    coachId: string,
    graceMs: number,
    expectedCode?: string | null,
  ): Promise<{
    profile: Awaited<ReturnType<InviteCodesService['getOrCreateDefaultForCoach']>>;
    previous: { id: string; code: string; expires_at: Date | null; revoked: boolean };
    replayed: boolean;
    successorCode: string;
  }> {
    await this.getOrCreateDefaultForCoach(coachId);
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      const next = await this.generateCodeUniqueAcrossTables();
      try {
        return await this.prisma.$transaction(async (tx) => {
          const current = await tx.coachProfile.findUnique({ where: { user_id: coachId } });
          if (!current) throw new NotFoundException({ code: 'coach_profile_missing', message: 'Coach profile not found' });
          if (expectedCode && current.invite_code !== expectedCode) throw new LinkAlreadyRotated();
          const now = new Date();
          const archived = await tx.inviteCode.create({
            data: {
              code: current.invite_code,
              coach_id: coachId,
              label: 'Previous coach link',
              max_uses: null,
              expires_at: graceMs > 0 ? new Date(now.getTime() + graceMs) : null,
              revoked: graceMs <= 0,
              revoked_at: graceMs <= 0 ? now : null,
              package_id: current.invite_code_package_id,
              grant_mode: current.invite_code_grant_mode,
              successor_code: next,
            },
            select: { id: true, code: true, expires_at: true, revoked: true },
          });
          // Conditional on the code we archived: a concurrent rotation that
          // already moved the link makes this a no-op, and throwing rolls the
          // archive back so exactly one rotation wins.
          const moved = await tx.coachProfile.updateMany({
            where: { user_id: coachId, invite_code: current.invite_code },
            data: { invite_code: next },
          });
          if (moved.count !== 1) {
            if (expectedCode) throw new LinkAlreadyRotated();
            throw linkRotationConflict();
          }
          const profile = await tx.coachProfile.findUnique({ where: { user_id: coachId } });
          if (!profile) throw new NotFoundException({ code: 'coach_profile_missing', message: 'Coach profile not found' });
          return { profile, previous: archived, replayed: false, successorCode: next };
        });
      } catch (err) {
        if (err instanceof LinkAlreadyRotated && expectedCode) {
          // Nothing is written: the archived row of the expected code names its successor.
          const previous = await this.prisma.inviteCode.findUnique({
            where: { code: expectedCode },
            select: { id: true, code: true, expires_at: true, revoked: true, coach_id: true, successor_code: true },
          });
          if (!previous || previous.coach_id !== coachId || !previous.successor_code) throw linkRotationConflict();
          const profile = await this.getOrCreateDefaultForCoach(coachId);
          return { profile, previous, replayed: true, successorCode: previous.successor_code };
        }
        // A duplicate archive of the same code means a concurrent rotation won:
        // the next attempt sees the moved link (and, with expectedCode, replays it).
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
    throw new InternalServerErrorException('Could not generate a unique invite code');
  }

  /**
   * A2 — a `GP-XXXXXX` candidate that is not in use as a coach link OR an
   * InviteCode row (attach resolves the coach link first, so a cross-table
   * duplicate would shadow a row). The unique indexes stay the final word;
   * callers still retry on P2002.
   */
  async generateCodeUniqueAcrossTables(): Promise<string> {
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
      const candidate = this.generateCode();
      const [profile, row] = await Promise.all([
        this.prisma.coachProfile.findUnique({ where: { invite_code: candidate }, select: { id: true } }),
        this.prisma.inviteCode.findUnique({ where: { code: candidate }, select: { id: true } }),
      ]);
      if (!profile && !row) return candidate;
    }
    throw new InternalServerErrorException('Could not generate a unique invite code');
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
        err instanceof Prisma.PrismaClientKnownRequestError ? `prisma:${err.code}` : 'unknown';
      this.logger.error(`previewCode failed (${code_class}): ${(err as Error).message}`);
      return { valid: false };
    }
  }

  // ---- Phase 1C: link / attach existing user to a coach -------------
  //
  // Used after a client signs in via Google (no invite_code on the
  // initial OAuth roundtrip) and then enters the coach's invite code
  // from the post-OAuth screen. Atomic + idempotent — also used by the
  // `signup-with-code` flow once the user record exists.
  //
  // Clinic C13 fix round (audits: Opus B1 / Grok A2): a coach-like account
  // (coach, sub_coach, owner) is REFUSED with a structured code instead of
  // being silently rewritten to `role:'student'`. Redeeming a code used to
  // demote a head coach, orphan their roster (User.coach_id of every client
  // still pointed at them) and leave their CoachSubscription + invite code
  // live. The role is fixed at account creation (R-ROLE-CHOICE-1); a change
  // is an OWNER action, never a side effect of typing a code.
  // Clinic launch C03 — contract:
  //   * every failure carries a machine-readable `code` (INVITE_ATTACH_ERROR);
  //   * a student already attached to the SAME coach gets an idempotent
  //     success (`already_attached: true`, no seat consumed, no re-write);
  //   * a student already attached to a DIFFERENT coach is refused with
  //     409 `already_attached_to_different_coach` — re-parenting is an
  //     explicit coach/owner action, never a side effect of typing a code.
  async attachUserToCoachByCode(
    userId: string,
    rawCode: string,
  ): Promise<AttachResult> {
    // The throttler predicate and the mobile client both trim; do the same
    // here so a pasted code with stray whitespace resolves (case is preserved).
    const code = rawCode.trim();

    // 1. Resolve the code to its coach WITHOUT lifecycle checks, so the
    //    redeemer's own state can be classified first (Sol SOL-C03-B1).
    const target = await this.resolveAttachTarget(code);
    if (!target) throw invalidInviteCode();

    const me = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!me) {
      throw new NotFoundException({
        code: INVITE_ATTACH_ERROR.USER_NOT_FOUND,
        message: 'User not found',
      });
    }
    // Owner / coach / sub_coach are refused, never demoted or re-parented.
    if (me.role !== 'student') {
      this.logger.warn(
        `attach refused: user=${userId} role=${me.role} tried to redeem a client invite code (not a student)`,
      );
    }
    assertRedeemerIsStudent(me);

    // 2. Already a client of some coach?
    if (me.coach_id) {
      if (me.coach_id === target.coachId) {
        // Sol SOL-C03-B1 — idempotent replay. A retried request (network
        // retry, cached OAuth code, the same single-use invite submitted
        // twice) succeeds as `already_attached: true` even though that
        // invite is now exhausted, expired or revoked: nothing is written,
        // no seat is consumed, the role is untouched, and INVITE_REDEEMED is
        // not re-emitted. Attach state cannot change here, so there is
        // nothing for the lifecycle rules to protect; any GRANT attached to
        // the code is authorised separately and strictly (C01).
        this.logger.debug(`attach no-op: user=${userId} already attached to coach=${target.coachId}`);
        const grant = await this.grantAfterAttach(userId, me.coach_id, code, 'replay');
        return { role: me.role, coach_id: me.coach_id, already_attached: true, ...(grant ? { grant } : {}) };
      }
      this.logger.warn(
        `attach refused: user=${userId} already attached to a different coach (re-parent is not a side effect of code entry)`,
      );
      throw new ConflictException({
        code: INVITE_ATTACH_ERROR.ALREADY_ATTACHED_TO_DIFFERENT_COACH,
        message: 'You are already attached to a different coach',
      });
    }

    // 3. A NEW redemption: every lifecycle rule applies.
    if (target.kind === 'row') {
      const v = await this.validate(code);
      if (!v.valid) throw inviteCodeLifecycleRefusal(v.reason);
      if (v.coach_id !== target.coachId) throw invalidInviteCode();
    } else if (target.coachRole !== 'coach') {
      throw invalidInviteCode();
    }
    await this.assertCoachCanAcceptClients(target.coachId);

    const coachId = target.coachId;
    const inviteCodeRowId = target.kind === 'row' ? target.rowId : null;
    let result: { role: string; coach_id: string | null; already_attached: boolean };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        // Everything that can refuse runs on a fresh in-transaction read
        // BEFORE the seat is consumed; a stale pre-read cannot slip through.
        const fresh = await tx.user.findUnique({ where: { id: userId } });
        if (!fresh) {
          throw new NotFoundException({
            code: INVITE_ATTACH_ERROR.USER_NOT_FOUND,
            message: 'User not found',
          });
        }
        assertRedeemerIsStudent(fresh);
        if (fresh.coach_id) {
          if (fresh.coach_id === coachId) throw new AttachRaceSameCoach(coachId);
          throw new ConflictException({
            code: INVITE_ATTACH_ERROR.ALREADY_ATTACHED_TO_DIFFERENT_COACH,
            message: 'You are already attached to a different coach',
          });
        }

        if (inviteCodeRowId) {
          await this.consumeInviteSeat(tx, inviteCodeRowId, fresh.email, userId);
        }

        // Conditional attach: only a student with NO coach is written, and
        // ONLY coach_id changes — role is never rewritten by code entry.
        const attached = await tx.user.updateMany({
          where: { id: userId, role: 'student', coach_id: null },
          data: { coach_id: coachId },
        });
        if (attached.count !== 1) {
          // Lost the race between the read above and this write. Throwing
          // rolls the seat bump back; classify from a fresh read.
          const now = await tx.user.findUnique({ where: { id: userId } });
          if (now && now.role === 'student' && now.coach_id === coachId) {
            throw new AttachRaceSameCoach(coachId);
          }
          if (now) assertRedeemerIsStudent(now);
          throw new ConflictException({
            code: INVITE_ATTACH_ERROR.ALREADY_ATTACHED_TO_DIFFERENT_COACH,
            message: 'You are already attached to a different coach',
          });
        }
        // A2 — signup ledger: exactly one row per NEW redemption, written in
        // the attach transaction so a rolled-back attach never counts and a
        // committed one always does (daily signups per code and package).
        await tx.inviteRedemption.create({
          data: {
            coach_id: coachId,
            client_user_id: userId,
            invite_code_id: inviteCodeRowId,
            code: target.code,
            source: target.kind === 'row' ? 'invite_code' : 'coach_link',
            package_id: target.packageId,
          },
        });
        return { role: 'student', coach_id: coachId, already_attached: false };
      });
    } catch (err) {
      if (err instanceof AttachRaceSameCoach) {
        this.logger.debug(`attach race resolved as no-op: user=${userId} coach=${err.coachId}`);
        const grant = await this.grantAfterAttach(userId, err.coachId, code, 'replay');
        return { role: 'student', coach_id: err.coachId, already_attached: true, ...(grant ? { grant } : {}) };
      }
      throw err;
    }

    // Clinic C01 — a bound code grants its package AFTER the attach
    // committed. Only on success (never after a refusal); the grant can
    // never undo the attach.
    const grant = await this.grantAfterAttach(userId, coachId, code, 'new');
    this.analytics.capture(userId, Events.INVITE_REDEEMED, {
      via: 'attach_code',
      coach_id: coachId,
      legacy_invite_row: !!inviteCodeRowId,
      already_attached: false,
      grant_status: grant?.status ?? null,
    });
    return { ...result, ...(grant ? { grant } : {}) };
  }

  /** C01 — post-commit, never-throwing grant for a bound code. */
  private async grantAfterAttach(
    userId: string,
    coachId: string | null,
    code: string,
    redemption: 'new' | 'replay',
  ): Promise<AttachGrant | null> {
    if (!this.grants || !coachId) return null;
    try {
      const binding = await this.grants.resolveBinding(code);
      if (!binding || !binding.package_id || binding.grant_mode === 'none') return null;
      const outcome = await this.grants.grantForAttachedCode({
        clientUserId: userId,
        coachUserId: coachId,
        binding,
        redemption,
      });
      return outcome ? { ...outcome, package_id: binding.package_id } : null;
    } catch (err) {
      this.logger.warn(
        `grant lookup failed after attach: user=${userId} coach=${coachId} — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { purchase_id: null, status: 'failed', package_id: null };
    }
  }

  /**
   * Resolve a code string to the coach it belongs to, with NO lifecycle
   * checks (revoked / expired / exhausted are judged later, and only for a
   * new redemption). Permanent coach code first, then per-row InviteCode.
   */
  private async resolveAttachTarget(
    code: string,
  ): Promise<
    | { kind: 'profile'; coachId: string; coachRole: string | null; code: string; packageId: string | null }
    | { kind: 'row'; coachId: string; rowId: string; code: string; packageId: string | null }
    | null
  > {
    const profile = await this.prisma.coachProfile.findUnique({
      where: { invite_code: code },
      include: { user: { select: { id: true, role: true } } },
    });
    if (profile?.user) {
      return {
        kind: 'profile',
        coachId: profile.user.id,
        coachRole: profile.user.role ?? null,
        code: profile.invite_code ?? code,
        packageId: profile.invite_code_package_id ?? null,
      };
    }
    const row = await this.prisma.inviteCode.findUnique({
      where: { code },
      select: { id: true, coach_id: true, code: true, package_id: true },
    });
    if (row) {
      return {
        kind: 'row',
        coachId: row.coach_id,
        rowId: row.id,
        code: row.code ?? code,
        packageId: row.package_id ?? null,
      };
    }
    return null;
  }

  /**
   * Validate a per-row InviteCode and consume ONE seat atomically inside the
   * caller's transaction. The increment is conditional on capacity
   * (`used_count < max_uses`), not on an optimistic equality snapshot, so two
   * clients redeeming the same code at the same moment both succeed instead
   * of the loser seeing a false "invalid code". Only a revoked / exhausted /
   * expired code, or an intended-email mismatch, fails. The first redeemer is
   * recorded in `accepted_by_user_id` / `accepted_at` (attribution for a
   * single-recipient invite; never overwritten).
   */
  private async consumeInviteSeat(
    tx: Prisma.TransactionClient,
    inviteCodeRowId: string,
    redeemerEmailRaw: string | null | undefined,
    redeemerUserId: string,
  ): Promise<void> {
    const current = await tx.inviteCode.findUnique({ where: { id: inviteCodeRowId } });
    if (!current) {
      throw invalidInviteCode();
    }
    // A2 — fresh in-transaction read; a code revoked / expired / filled
    // between validate() and here gets its specific refusal.
    const lifecycle = inviteCodeRowLifecycle(current);
    if (lifecycle) throw inviteCodeLifecycleRefusal(lifecycle);
    // Validate intended recipient — prevents forwarded-code abuse.
    if (current.intended_email) {
      const redeemerEmail = (redeemerEmailRaw ?? '').toLowerCase().trim();
      const intendedEmail = current.intended_email.toLowerCase().trim();
      if (redeemerEmail !== intendedEmail) {
        throw new BadRequestException({
          code: INVITE_ATTACH_ERROR.INVITE_INTENDED_EMAIL_MISMATCH,
          message: 'This invite was sent to a different email address',
        });
      }
    }
    const bumped = await tx.inviteCode.updateMany({
      where: {
        id: inviteCodeRowId,
        revoked: false,
        // Conditional on capacity, NOT on an equality snapshot: two
        // concurrent redemptions both succeed; only exhaustion fails.
        ...(current.max_uses !== null ? { used_count: { lt: current.max_uses } } : {}),
      },
      data: { used_count: { increment: 1 } },
    });
    if (bumped.count !== 1) {
      // Lost the last seat (or a revoke) to a concurrent request: classify
      // from a fresh read so the client sees the real reason.
      const after = await tx.inviteCode.findUnique({ where: { id: inviteCodeRowId } });
      throw inviteCodeLifecycleRefusal(after ? (inviteCodeRowLifecycle(after) ?? 'max_uses_reached') : null);
    }
    if (!current.accepted_by_user_id) {
      await tx.inviteCode.updateMany({
        where: { id: inviteCodeRowId, accepted_by_user_id: null },
        data: { accepted_by_user_id: redeemerUserId, accepted_at: new Date() },
      });
    }
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
      // AUDIT-17-125 — the first send spent `invite:<id>`, so a resend with
      // that key was always `skipped`. One key per minute: a double tap
      // still sends once, a later Resend really sends.
      idempotencyKey: `invite:${row.id}:resend:${Math.floor(Date.now() / 60_000)}`,
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
    idempotencyKey?: string;
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
      idempotencyKey: params.idempotencyKey ?? `invite:${params.inviteCodeId}`,
      data: {
        coach_name: params.coachName,
        recipient_name: params.recipientName ?? null,
        personal_note: params.personalNote ?? null,
        accept_url: acceptUrl,
        invite_code: params.inviteCode,
        expires_at: expiresAtDisplay,
      },
    });
    return res.error ? { status: res.status, error: res.error } : { status: res.status };
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
    | {
        accepted: true;
        email: string | null;
        coachName: string | null;
        redirectTo: 'signup' | 'app_open';
      }
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
          return {
            accepted: false,
            reason: 'invalid',
            message: 'This coach is not currently accepting clients.',
          };
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
        return {
          accepted: false,
          reason: 'invalid',
          message: 'This invite code has been revoked.',
        };
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
        return {
          accepted: false,
          reason: 'already_accepted',
          message: 'This invite has already been used.',
        };
      }

      if (record.coach.role !== 'coach') {
        return {
          accepted: false,
          reason: 'invalid',
          message: 'This invite code is no longer valid.',
        };
      }

      // Verify the coach still has an active subscription before accepting the invite.
      try {
        await this.assertCoachCanAcceptClients(record.coach.id);
      } catch {
        return {
          accepted: false,
          reason: 'invalid',
          message: 'This coach is not currently accepting clients.',
        };
      }

      return {
        accepted: true,
        email: null,
        coachName: record.coach.name,
        redirectTo: 'signup',
      };
    } catch (err) {
      const code_class =
        err instanceof Prisma.PrismaClientKnownRequestError ? `prisma:${err.code}` : 'unknown';
      this.logger.error(`acceptByToken failed (${code_class}): ${(err as Error).message}`);
      return {
        accepted: false,
        reason: 'invalid',
        message: 'Unable to validate invite at this time.',
      };
    }
  }

  // Helper: parse a coach's pasted CSV/newline-separated text into
  // {email,name?,note?} rows. Liberal accept: comma- or tab-separated,
  // up to 3 fields per line. Emails are validated as a final pass at
  // the DTO layer when the parsed rows are POSTed back.
  parsePasted(
    input: string,
    maxRows = 100,
  ): {
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
