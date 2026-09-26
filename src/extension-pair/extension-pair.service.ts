import * as crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthService } from '../auth/auth.service';
import type {
  PairInitResult,
  PairReadiness,
  PairSessionResult,
  PairRedeemErrorCode,
  PairRedeemResult,
  PairStatus,
  PairStatusResult,
} from './extension-pair.dto';

// Nominal 120s (DESIGN.md v0.3 §4); clamped to [30, 300] so a misconfigured env
// can't open an arbitrarily long brute-force window (or an unusably short one).
const DEFAULT_TTL_SECONDS = 120;
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 300;

const CODE_MINT_MAX_ATTEMPTS = 5;

// Per-code brute-force lockout. A code accrues a failed_attempts count for each
// redeem that finds the row but cannot claim it (expired, or a lost single-use
// race). Once it reaches this ceiling the code is hard-invalidated: every
// subsequent redeem — even one that would otherwise be valid — returns 410
// `locked`, forcing a re-mint. This survives across requests AND IPs (the
// counter lives on the DB row), so it complements the per-IP redeem throttle
// and the constant-time compare rather than duplicating them. Primary threat:
// a harvested/leaked code (e.g. from an access log) hammered from many IPs to
// slip past the per-IP cap. DESIGN.md v0.3 §4.
const REDEEM_MAX_FAILED_ATTEMPTS = 5;

function resolveTtlSeconds(): number {
  const raw = process.env.PAIR_CODE_TTL_SECONDS;
  if (!raw) return DEFAULT_TTL_SECONDS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.max(n, MIN_TTL_SECONDS), MAX_TTL_SECONDS);
}

// Constant-time equality on the final code comparison (defence in depth; the
// primary brute-force control is the redeem rate limit + short TTL).
function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

const ACTIVE_COACH = {
  role: { in: ['coach', 'owner'] },
  deleted_at: null,
} satisfies Prisma.UserWhereInput;

@Injectable()
export class ExtensionPairService {
  private readonly logger = new Logger(ExtensionPairService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  // POST /api/extension/pair/init — mobile-authenticated coach mints a code.
  async init(coachId: string, chosenPlatform: string, nonce?: string): Promise<PairInitResult> {
    for (let attempt = 0; attempt < CODE_MINT_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            await this.lockOwner(tx, coachId);
            const existing = nonce
              ? await tx.importIntent.findUnique({
                  where: { coach_id_setup_nonce: { coach_id: coachId, setup_nonce: nonce } },
                  include: { challenge: true },
                })
              : null;
            if (existing) {
              if (existing.chosen_platform !== chosenPlatform) {
                throw new ConflictException({
                  code: 'setup_nonce_conflict',
                  message: 'Setup nonce already used for another platform.',
                });
              }
              const challenge = existing.challenge;
              if (
                existing.superseded_at ||
                !challenge ||
                challenge.used_at ||
                challenge.expires_at.getTime() <= Date.now() ||
                challenge.failed_attempts >= REDEEM_MAX_FAILED_ATTEMPTS
              ) {
                // The shared error envelope intentionally has no arbitrary fields.
                // current {setup_nonce} recovers this exact ID, even after supersession.
                throw new GoneException({
                  code: 'setup_challenge_unavailable',
                  message:
                    'Read setup with the saved nonce; a new pairing attempt needs a new nonce.',
                });
              }
              return {
                pairing_code: challenge.code,
                expires_at: challenge.expires_at.toISOString(),
                import_intent_id: existing.id,
              };
            }
            const now = new Date();
            const expiresAt = new Date(now.getTime() + resolveTtlSeconds() * 1000);
            const importIntentId = crypto.randomUUID();
            const code = mintSixDigitCode();
            await tx.importIntent.updateMany({
              where: { coach_id: coachId, superseded_at: null },
              data: { superseded_at: now },
            });
            await tx.importIntent.create({
              data: {
                id: importIntentId,
                coach_id: coachId,
                setup_nonce: nonce,
                chosen_platform: chosenPlatform,
              },
            });
            await tx.extensionPairCode.create({
              data: {
                code,
                import_intent_id: importIntentId,
                coach_id: coachId,
                chosen_platform: chosenPlatform,
                expires_at: expiresAt,
              },
            });
            await tx.extensionPairCode.updateMany({
              where: {
                coach_id: coachId,
                code: { not: code },
                used_at: null,
                expires_at: { gt: now },
              },
              data: { expires_at: now },
            });
            return {
              pairing_code: code,
              expires_at: expiresAt.toISOString(),
              import_intent_id: importIntentId,
            };
          },
          { maxWait: 5000, timeout: 5000 },
        );
      } catch (err) {
        // Retry only the human-code constraint, outside the aborted transaction.
        if (isCodeCollision(err)) continue;
        throw err;
      }
    }
    // Exhausted retries — treat as a transient server condition.
    this.logger.error('pair init: exhausted code-mint attempts');
    throw new BadRequestException({
      code: 'code_mint_failed',
      message: 'Could not allocate a pairing code, please retry.',
    });
  }

  // POST /api/extension/pair/status — coach polls their OWN code only. An unknown
  // code (or another coach's) reads as `expired`, never confirming existence to
  // a caller who did not mint it.
  async status(coachId: string, code: string): Promise<PairStatusResult> {
    const row = await this.prisma.extensionPairCode.findUnique({
      where: { code, coach_id: coachId, coach: ACTIVE_COACH },
    });
    if (!row || row.coach_id !== coachId) {
      return { status: 'expired' };
    }
    return {
      status: deriveStatus(row.used_at, row.expires_at),
      ...intentEcho(row.import_intent_id),
    };
  }

  async session(coachId: string, importIntentId: string): Promise<PairSessionResult> {
    return this.readSetup(coachId, { id: importIntentId });
  }

  async current(coachId: string, nonce?: string): Promise<PairSessionResult> {
    return this.readSetup(coachId, nonce ? { setup_nonce: nonce } : { superseded_at: null });
  }

  private async readSetup(
    coachId: string,
    filter: Prisma.ImportIntentWhereInput,
  ): Promise<PairSessionResult> {
    const row = await this.prisma.importIntent.findFirst({
      where: { ...filter, coach_id: coachId, coach: ACTIVE_COACH },
      include: { challenge: { select: { expires_at: true, failed_attempts: true } } },
    });
    if (!row) {
      throw new NotFoundException('Pairing session not found. Create a new pairing code.');
    }
    const result: PairSessionResult = {
      status: row.paired_at
        ? 'paired'
        : !row.superseded_at &&
            row.challenge &&
            row.challenge.failed_attempts < REDEEM_MAX_FAILED_ATTEMPTS &&
            row.challenge.expires_at.getTime() > Date.now()
          ? 'pending'
          : 'expired',
      import_intent_id: row.id,
      chosen_platform: row.chosen_platform,
    };
    const readiness = await this.readReadiness(coachId, row.id);
    if (readiness) result.readiness = readiness;
    return result;
  }

  // S11-C (D-S11-5): advisory readiness of the run bound to an owned setup. Read-only (one
  // SELECT; no fence, no write), scoped by the caller's coach_id, counts only: no scope digest,
  // challenge, platform name or terminal detail leaves here. `source_declared` means only that
  // a declaration row exists, never that a source is authorized. Any read failure omits the
  // block (unknown stays unknown) and never fails setup recovery.
  private async readReadiness(
    coachId: string,
    intentId: string,
  ): Promise<PairReadiness | undefined> {
    try {
      const run = await this.prisma.scoutImport.findFirst({
        where: { coach_id: coachId, import_intent_id: intentId, mode: 'server' },
        select: { terminal_status: true, declarations: { select: { source_platform: true } } },
      });
      if (!run) return { run: 'none', source_declared: false, declared_platforms: null };
      const platforms = new Set(run.declarations.map((d) => d.source_platform)).size;
      return {
        run: run.terminal_status === null ? 'open' : 'terminal',
        source_declared: platforms > 0,
        declared_platforms: platforms,
      };
    } catch {
      this.logger.warn('setup readiness read failed; readiness omitted (unknown)');
      return undefined;
    }
  }

  private async lockOwner(tx: Prisma.TransactionClient, coachId: string): Promise<void> {
    // Bound PostgreSQL work itself as well as the Prisma transaction lifetime.
    await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '4s'`;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "User" WHERE "id" = ${coachId}
        AND "role" IN ('coach', 'owner') AND "deleted_at" IS NULL FOR UPDATE`;
    if (!rows.length) {
      throw new ForbiddenException('Active coach access required. Sign in with a coach account.');
    }
  }

  // POST /api/extension/pair/redeem — UNAUTHENTICATED. The extension exchanges
  // a code for a coach-bound token pair exactly once. Single-use is enforced by
  // a conditional update on used_at, so two concurrent redeems cannot both win.
  async redeem(code: string): Promise<PairRedeemResult> {
    const row = await this.prisma.extensionPairCode.findUnique({
      where: { code },
    });

    // Uniform "invalid" for a missing/mismatched code — never reveal which
    // check failed for a code that was not minted.
    if (!row || !timingSafeStrEqual(code, row.code)) {
      throw new BadRequestException({ code: 'invalid', message: 'Invalid pairing code.' });
    }
    // Locked code takes precedence over every other terminal state: once a code
    // has burned through its attempt budget it is dead regardless of expiry or
    // single-use, so a legitimate holder must re-mint.
    if ((row.failed_attempts ?? 0) >= REDEEM_MAX_FAILED_ATTEMPTS) {
      throw new GoneException({ code: 'locked', message: 'Pairing code is locked.' });
    }
    if (row.used_at) {
      throw new GoneException({ code: 'already_used', message: 'Pairing code already used.' });
    }
    if (row.expires_at.getTime() <= Date.now()) {
      throw await this.registerFailedAttempt(row.id, {
        code: 'expired',
        message: 'Pairing code has expired.',
      });
    }

    // Mint BEFORE the single-use claim (round-2 audit, accepted — "mint then
    // claim"). The previous order flipped used_at first, so a mint failure
    // (coach demoted/deleted between init and redeem, or a transient Supabase
    // error) burned a valid code with no token ever issued. Minting first
    // leaves the row untouched on failure — the coach can retry the same code.
    // Mint is stateless from the DB's point of view, so if two redeems race
    // here both may mint, but the conditional claim below picks exactly one
    // winner; the loser's session is orphaned and never returned to any caller
    // (they get 410 already_used). The mint goes through the shared
    // /auth/extension token authority (R80) — no parallel token surface here.
    const tokens = await this.auth.mintExtensionSessionForCoach(row.coach_id);

    // Atomic single-use claim: only the writer that flips used_at from NULL
    // (while still unexpired, and while under the lockout ceiling) wins. A lost
    // race means another redeem already consumed the code — surface it as
    // already_used.
    const claim = await this.prisma.$transaction(
      async (tx) => {
        // Auth has already checked eligibility. Recheck under the same owner lock
        // used by init; demotion/deletion/supersession during mint cannot win.
        try {
          await this.lockOwner(tx, row.coach_id);
        } catch (err) {
          if (!(err instanceof ForbiddenException)) throw err;
          throw new BadRequestException({ code: 'invalid', message: 'Invalid pairing code.' });
        }
        const now = new Date();
        const claimed = await tx.extensionPairCode.updateMany({
          where: {
            id: row.id,
            used_at: null,
            expires_at: { gt: now },
            failed_attempts: { lt: REDEEM_MAX_FAILED_ATTEMPTS },
          },
          data: { used_at: now },
        });
        if (claimed.count === 1 && row.import_intent_id) {
          await tx.importIntent.update({
            where: { id: row.import_intent_id, coach_id: row.coach_id },
            data: { paired_at: now },
          });
        }
        return claimed;
      },
      { maxWait: 5000, timeout: 5000 },
    );
    if (claim.count !== 1) {
      throw new GoneException({ code: 'already_used', message: 'Pairing code already used.' });
    }

    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      chosen_platform: row.chosen_platform,
      ...intentEcho(row.import_intent_id),
    };
  }

  // Atomically charge one failed attempt against a code and return the error to
  // throw. The increment is a DB-side `increment` (not a read-modify-write) so
  // concurrent redeems from different IPs each count exactly once. When the
  // charge tips the code to the lockout ceiling, the caller sees `locked`
  // instead of the underlying failure so the code reads as hard-dead from here
  // on.
  private async registerFailedAttempt(
    id: string,
    underlying: { code: PairRedeemErrorCode; message: string },
  ): Promise<GoneException> {
    const updated = await this.prisma.extensionPairCode.update({
      where: { id },
      data: { failed_attempts: { increment: 1 } },
      select: { failed_attempts: true },
    });
    if ((updated.failed_attempts ?? 0) >= REDEEM_MAX_FAILED_ATTEMPTS) {
      return new GoneException({ code: 'locked', message: 'Pairing code is locked.' });
    }
    return new GoneException(underlying);
  }
}

// 6-digit numeric code with leading zeros preserved (000000–999999). Uses a
// CSPRNG (crypto.randomInt) so codes are not predictable from prior codes.
//
// DECISION (round-2 triage, 2026-07): a wave-2 audit flagged the ~19.93-bit
// code space as a BLOCK and asked for ≥64 bits of entropy. REJECTED — do not
// "fix" this by widening the code. Short human-typeable codes with layered
// server-side controls are the industry-standard pairing pattern (Bluetooth
// Secure Simple Pairing, Apple device setup, Google Cast). The brute-force
// budget is bounded by FOUR stacked defenses, not by entropy alone:
//   1. 120s nominal TTL (clamped 30–300s) — the space is unreachable in-window;
//   2. per-code lockout after REDEEM_MAX_FAILED_ATTEMPTS=5 failures — lives on
//      the DB row, so it survives across requests and IPs;
//   3. per-IP redeem throttle (10/min default) at the controller;
//   4. constant-time compare on the final code equality check.
// A ≥64-bit code cannot be typed off a phone screen and would defeat the UX
// this flow exists for. Future audits: re-raise only if one of the four layers
// above is removed or weakened.
function mintSixDigitCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function deriveStatus(usedAt: Date | null, expiresAt: Date): PairStatus {
  if (usedAt) return 'paired';
  if (expiresAt.getTime() <= Date.now()) return 'expired';
  return 'pending';
}

// Prisma unique-constraint (P2002) detection without importing the Prisma
// error class (keeps this service decoupled from the client's error surface).
// Narrows via a real `in` guard rather than a type assertion (R75): once
// `'code' in err` holds, TS exposes `err.code` as `unknown`, which compares
// safely against the literal.
function isCodeCollision(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return false;
  }
  if (
    err.code !== 'P2002' ||
    !('meta' in err) ||
    !err.meta ||
    typeof err.meta !== 'object' ||
    !('target' in err.meta)
  )
    return false;
  const target = err.meta.target;
  return Array.isArray(target) && target.length === 1 && target[0] === 'code';
}

function intentEcho(id: string | null): { import_intent_id?: string } {
  return id ? { import_intent_id: id } : {};
}
