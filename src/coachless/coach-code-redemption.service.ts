import { HttpException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { describeFailure } from '../observability/log-pii';
import {
  INVITE_ATTACH_ERROR,
  InviteCodesService,
  inviteAttachErrorCode,
  type AttachGrant,
} from '../invite-codes/invite-codes.service';
import {
  CoachCodeLookupService,
  isUniqueViolation,
  type CoachCard,
} from './coach-code-lookup.service';
import { FeaturedCoachService, type FeaturedPackage } from './featured-coach.service';
import { COACHLESS_ERROR, CoachlessError, type CoachlessErrorCode } from './coachless.errors';

/** An in_progress claim older than this is treated as abandoned (crash) and may be reclaimed. */
export const REDEMPTION_STALE_MS = 60_000;
/** How long a concurrent same-key request waits for the winner before answering 409 in_progress. */
export const REDEMPTION_REPLAY_WAIT_MS = 5_000;
const REPLAY_POLL_MS = 100;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Response of a successful redemption (also what a replay returns). */
export interface RedeemResponse {
  status: 'attached';
  /** false = this request attached the client (show the welcome moment); true = already this coach's client. */
  already_attached: boolean;
  coach: CoachCard;
  next: {
    /** The package to offer first: the code's bound package, else the featured offer's package for this coach. */
    featured_package: FeaturedPackage | null;
    /** Active packages the coach sells; 0 means the welcome screen leads to messaging instead of a plan. */
    packages_available: number;
  };
  grant: AttachGrant | null;
  replayed: boolean;
}

/** Map the canonical attach writer's codes onto the coachless contract. */
const ATTACH_TO_COACHLESS: Record<string, CoachlessErrorCode> = {
  [INVITE_ATTACH_ERROR.COACH_NOT_ACCEPTING_CLIENTS]: COACHLESS_ERROR.COACH_NOT_ACCEPTING,
  [INVITE_ATTACH_ERROR.ALREADY_ATTACHED_TO_DIFFERENT_COACH]: COACHLESS_ERROR.ALREADY_ATTACHED,
  [INVITE_ATTACH_ERROR.INVITE_INTENDED_EMAIL_MISMATCH]: COACHLESS_ERROR.CODE_EMAIL_MISMATCH,
  [INVITE_ATTACH_ERROR.OWNER_CANNOT_REDEEM]: COACHLESS_ERROR.ROLE_CANNOT_REDEEM,
  [INVITE_ATTACH_ERROR.COACH_CANNOT_REDEEM]: COACHLESS_ERROR.ROLE_CANNOT_REDEEM,
  [INVITE_ATTACH_ERROR.USER_NOT_FOUND]: COACHLESS_ERROR.ACCOUNT_NOT_FOUND,
  // b#658 (invite codes A2): the writer now names the lifecycle refusal itself.
  [INVITE_ATTACH_ERROR.CODE_REVOKED]: COACHLESS_ERROR.CODE_REVOKED,
  [INVITE_ATTACH_ERROR.CODE_EXPIRED]: COACHLESS_ERROR.CODE_EXPIRED,
  [INVITE_ATTACH_ERROR.CODE_EXHAUSTED]: COACHLESS_ERROR.CODE_EXHAUSTED,
};

/**
 * A1-COACHLESS — post-signup coach-code redemption.
 *
 * - Tenancy: the ONLY writer of User.coach_id stays
 *   InviteCodesService.attachUserToCoachByCode (conditional attach, no
 *   re-parenting, no role rewrite). This service adds the idempotency
 *   ledger, specific error codes and the welcome-moment payload on top.
 * - Idempotency: one CoachCodeRedemption row per (user, Idempotency-Key).
 *   A completed key replays its stored response byte-for-byte (so a lost
 *   response still shows the welcome moment); the same key with a different
 *   code is 422; a concurrent duplicate waits for the winner; a failed key
 *   may be retried; an abandoned in_progress claim is reclaimed after
 *   REDEMPTION_STALE_MS.
 * - Featured offer: when the code is the owner's featured code and the owner
 *   has paused it (accepting_clients=false), redemption is refused with
 *   coach_not_accepting before any write.
 */
@Injectable()
export class CoachCodeRedemptionService {
  private readonly logger = new Logger(CoachCodeRedemptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inviteCodes: InviteCodesService,
    private readonly lookup: CoachCodeLookupService,
    private readonly featured: FeaturedCoachService,
    private readonly audit: AuditService,
  ) {}

  static requestHash(code: string): string {
    return createHash('sha256')
      .update(JSON.stringify({ action: 'coach_code_redeem', code: code.trim().toUpperCase() }))
      .digest('hex');
  }

  /**
   * Instant validation for the code sheet (no write, no seat). Same refusal
   * order as a redemption so the sheet and the Join button never disagree.
   */
  async check(
    user: { id: string; role: string; coach_id: string | null },
    rawCode: string,
  ): Promise<{ valid: true; coach: CoachCard } | { valid: false; code: CoachlessErrorCode }> {
    if (user.role !== 'student') return { valid: false, code: COACHLESS_ERROR.ROLE_CANNOT_REDEEM };
    const resolved = await this.lookup.resolve(rawCode);
    if (user.coach_id) {
      if (resolved && resolved.coachId === user.coach_id) {
        const card = await this.lookup.coachCard(resolved.coachId);
        if (card) return { valid: true, coach: card };
      }
      return { valid: false, code: COACHLESS_ERROR.ALREADY_ATTACHED };
    }
    const refusal =
      (await this.lookup.refusalFor(resolved)) ?? (await this.featuredPauseRefusal(resolved?.code));
    if (refusal || !resolved)
      return { valid: false, code: refusal ?? COACHLESS_ERROR.CODE_INVALID };
    const card = await this.lookup.coachCard(resolved.coachId);
    return card
      ? { valid: true, coach: card }
      : { valid: false, code: COACHLESS_ERROR.CODE_INVALID };
  }

  async redeem(args: {
    userId: string;
    rawCode: string;
    idempotencyKey: string;
    requestId?: string;
    /** Coach sharing at join: the notice version the sheet showed. */
    coachSharingNotice?: string;
  }): Promise<RedeemResponse> {
    const { userId, rawCode, idempotencyKey, requestId, coachSharingNotice } = args;
    if (!UUID_RE.test(idempotencyKey))
      throw new CoachlessError(COACHLESS_ERROR.IDEMPOTENCY_KEY_REQUIRED);
    const hash = CoachCodeRedemptionService.requestHash(rawCode);

    const claim = await this.claim(userId, idempotencyKey, hash);
    if (claim.kind === 'replay') return { ...claim.response, replayed: true };

    try {
      const response = await this.execute(userId, rawCode, coachSharingNotice);
      await this.prisma.coachCodeRedemption.update({
        where: { id: claim.id },
        data: {
          status: 'completed',
          outcome: response.already_attached ? 'already_attached_same_coach' : 'attached',
          coach_id: response.coach.id,
          http_status: 200,
          response: toJson(response),
        },
      });
      await this.audit.write({
        action: 'coach_code.redeemed',
        actorId: userId,
        actorRole: 'student',
        targetUserId: userId,
        targetType: 'CoachCodeRedemption',
        targetId: claim.id,
        tenantCoachId: response.coach.id,
        metadata: {
          already_attached: response.already_attached,
          grant_status: response.grant?.status ?? null,
        },
      });
      return response;
    } catch (err) {
      const mapped = this.toCoachlessError(err, requestId);
      await this.prisma.coachCodeRedemption
        .update({
          where: { id: claim.id },
          data: {
            status: 'failed',
            outcome: mapped.coachlessCode,
            http_status: mapped.getStatus(),
          },
        })
        .catch((e: unknown) =>
          this.logger.error(
            `redemption ledger failure-mark failed: ${describeFailure(e)}`,
          ),
        );
      await this.audit.write({
        action: 'coach_code.redeem_refused',
        actorId: userId,
        actorRole: null,
        targetUserId: userId,
        targetType: 'CoachCodeRedemption',
        targetId: claim.id,
        metadata: { code: mapped.coachlessCode },
      });
      if (mapped.coachlessCode === COACHLESS_ERROR.REDEMPTION_FAILED) {
        this.logger.error(
          `coach code redemption failed unexpectedly user=${userId} request=${requestId ?? 'none'}: ${
            describeFailure(err)
          }`,
        );
      }
      throw mapped;
    }
  }

  private async featuredPauseRefusal(code: string | undefined): Promise<CoachlessErrorCode | null> {
    if (!code) return null;
    const cfg = await this.featured.get();
    if (
      cfg.configured &&
      cfg.code &&
      cfg.code.toUpperCase() === code.toUpperCase() &&
      !cfg.accepting_clients
    ) {
      return COACHLESS_ERROR.COACH_NOT_ACCEPTING;
    }
    return null;
  }

  /** The redemption itself (runs while this request holds the claim). */
  private async execute(
    userId: string,
    rawCode: string,
    coachSharingNotice?: string,
  ): Promise<RedeemResponse> {
    const resolved = await this.lookup.resolve(rawCode);
    if (!resolved) throw new CoachlessError(COACHLESS_ERROR.CODE_INVALID);

    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { coach_id: true },
    });
    const isReplayOfSameCoach = !!me && me.coach_id === resolved.coachId;
    if (!isReplayOfSameCoach) {
      const paused = await this.featuredPauseRefusal(resolved.code);
      if (paused) throw new CoachlessError(paused);
    }

    let attach: Awaited<ReturnType<InviteCodesService['attachUserToCoachByCode']>>;
    try {
      attach = await this.inviteCodes.attachUserToCoachByCode(userId, resolved.code, {
        coachSharingNotice,
      });
    } catch (err) {
      const attachCode = inviteAttachErrorCode(err);
      if (attachCode === INVITE_ATTACH_ERROR.INVITE_CODE_INVALID) {
        // The canonical writer collapses every lifecycle failure; say which.
        const why = await this.lookup.refusalFor(await this.lookup.resolve(resolved.code));
        throw new CoachlessError(why ?? COACHLESS_ERROR.CODE_INVALID);
      }
      const mapped = ATTACH_TO_COACHLESS[attachCode];
      if (mapped) throw new CoachlessError(mapped);
      throw err;
    }

    const coachId = attach.coach_id ?? resolved.coachId;
    const coach = await this.lookup.coachCard(coachId);
    if (!coach) throw new CoachlessError(COACHLESS_ERROR.CODE_INVALID);
    return {
      status: 'attached',
      already_attached: attach.already_attached,
      coach,
      next: {
        featured_package: await this.featuredPackageFor(
          resolved.code,
          coachId,
          attach.grant ?? null,
        ),
        packages_available: await this.prisma.coachPackage.count({
          where: { coach_id: coachId, is_active: true, archived_at: null },
        }),
      },
      grant: attach.grant ?? null,
      replayed: false,
    };
  }

  /** The code's own bound package first; else the featured offer's package when it is this coach's. */
  private async featuredPackageFor(
    code: string,
    coachId: string,
    grant: AttachGrant | null,
  ): Promise<FeaturedPackage | null> {
    const bound =
      grant?.package_id ??
      (await this.prisma.inviteCode.findUnique({ where: { code }, select: { package_id: true } }))
        ?.package_id ??
      (
        await this.prisma.coachProfile.findUnique({
          where: { invite_code: code },
          select: { invite_code_package_id: true },
        })
      )?.invite_code_package_id ??
      null;
    if (bound) {
      const p = await this.featured.activePackageOf(bound, coachId);
      if (p) return p;
    }
    const cfg = await this.featured.get();
    if (cfg.package && cfg.coach?.id === coachId) return cfg.package;
    return null;
  }

  private toCoachlessError(err: unknown, requestId?: string): CoachlessError {
    if (err instanceof CoachlessError) return err;
    if (err instanceof HttpException) {
      const mapped = ATTACH_TO_COACHLESS[inviteAttachErrorCode(err)];
      if (mapped) return new CoachlessError(mapped);
    }
    return new CoachlessError(COACHLESS_ERROR.REDEMPTION_FAILED, { request_id: requestId });
  }

  /**
   * Claim (user, key). Returns the row id to execute under, or the stored
   * response to replay. Throws 422 on a different code and 409 when a
   * concurrent duplicate is still running after REDEMPTION_REPLAY_WAIT_MS.
   */
  private async claim(
    userId: string,
    key: string,
    hash: string,
  ): Promise<{ kind: 'run'; id: string } | { kind: 'replay'; response: RedeemResponse }> {
    try {
      const row = await this.prisma.coachCodeRedemption.create({
        data: { user_id: userId, idempotency_key: key, request_hash: hash, status: 'in_progress' },
        select: { id: true },
      });
      return { kind: 'run', id: row.id };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    const deadline = Date.now() + REDEMPTION_REPLAY_WAIT_MS;
    for (;;) {
      const row = await this.prisma.coachCodeRedemption.findUnique({
        where: { user_id_idempotency_key: { user_id: userId, idempotency_key: key } },
        select: { id: true, request_hash: true, status: true, response: true, updated_at: true },
      });
      if (!row) {
        // The winner's row vanished (account erasure race): start over once.
        return this.claimFresh(userId, key, hash);
      }
      if (row.request_hash !== hash)
        throw new CoachlessError(COACHLESS_ERROR.IDEMPOTENCY_KEY_REUSED);
      if (row.status === 'completed' && isRedeemResponse(row.response)) {
        return { kind: 'replay', response: row.response };
      }
      const stale =
        row.status === 'in_progress' && Date.now() - row.updated_at.getTime() > REDEMPTION_STALE_MS;
      if (row.status === 'failed' || stale) {
        // Conditional reclaim: exactly one retry wins the row.
        const won = await this.prisma.coachCodeRedemption.updateMany({
          where: { id: row.id, status: row.status, updated_at: row.updated_at },
          data: { status: 'in_progress', outcome: null, http_status: null },
        });
        if (won.count === 1) return { kind: 'run', id: row.id };
      }
      if (Date.now() >= deadline) throw new CoachlessError(COACHLESS_ERROR.REDEMPTION_IN_PROGRESS);
      await new Promise((r) => setTimeout(r, REPLAY_POLL_MS));
    }
  }

  private async claimFresh(
    userId: string,
    key: string,
    hash: string,
  ): Promise<{ kind: 'run'; id: string }> {
    try {
      const row = await this.prisma.coachCodeRedemption.create({
        data: { user_id: userId, idempotency_key: key, request_hash: hash, status: 'in_progress' },
        select: { id: true },
      });
      return { kind: 'run', id: row.id };
    } catch {
      throw new CoachlessError(COACHLESS_ERROR.REDEMPTION_IN_PROGRESS);
    }
  }
}

/** Plain JSON copy of a response for the ledger (Dates become ISO strings). */
function toJson(value: RedeemResponse): Prisma.InputJsonValue {
  const json: Prisma.InputJsonValue = JSON.parse(JSON.stringify(value));
  return json;
}

/** Narrow a stored ledger response back to the wire shape before replaying it. */
export function isRedeemResponse(value: unknown): value is RedeemResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const coach = v.coach as Record<string, unknown> | null | undefined;
  return (
    v.status === 'attached' &&
    typeof v.already_attached === 'boolean' &&
    !!coach &&
    typeof coach === 'object' &&
    typeof coach.id === 'string' &&
    typeof coach.name === 'string' &&
    !!v.next &&
    typeof v.next === 'object'
  );
}
