import * as crypto from 'crypto';
import { BadRequestException, GoneException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthService } from '../auth/auth.service';
import type {
  PairInitResult,
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

@Injectable()
export class ExtensionPairService {
  private readonly logger = new Logger(ExtensionPairService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  // POST /api/extension/pair/init — mobile-authenticated coach mints a code.
  async init(coachId: string, chosenPlatform: string): Promise<PairInitResult> {
    const ttlSeconds = resolveTtlSeconds();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    for (let attempt = 0; attempt < CODE_MINT_MAX_ATTEMPTS; attempt++) {
      const code = mintSixDigitCode();
      try {
        await this.prisma.extensionPairCode.create({
          data: {
            code,
            coach_id: coachId,
            chosen_platform: chosenPlatform,
            expires_at: expiresAt,
          },
        });
        return { pairing_code: code, expires_at: expiresAt.toISOString() };
      } catch (err) {
        // P2002 = unique-constraint violation on `code`. Extremely unlikely in
        // a 10^6 space; retry with a fresh code (falling through to the
        // exhaustion path below on the final attempt). Any other error
        // propagates immediately.
        if (isUniqueViolation(err)) {
          continue;
        }
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

  // GET /api/extension/pair/status — coach polls their OWN code only. An unknown
  // code (or another coach's) reads as `expired`, never confirming existence to
  // a caller who did not mint it.
  async status(coachId: string, code: string): Promise<PairStatusResult> {
    const row = await this.prisma.extensionPairCode.findUnique({
      where: { code },
    });
    if (!row || row.coach_id !== coachId) {
      return { status: 'expired' };
    }
    return { status: deriveStatus(row.used_at, row.expires_at) };
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

    // Atomic single-use claim: only the writer that flips used_at from NULL
    // (while still unexpired, and while under the lockout ceiling) wins. A lost
    // race means another redeem already consumed the code — surface it as
    // already_used.
    const claim = await this.prisma.extensionPairCode.updateMany({
      where: {
        id: row.id,
        used_at: null,
        expires_at: { gt: new Date() },
        failed_attempts: { lt: REDEEM_MAX_FAILED_ATTEMPTS },
      },
      data: { used_at: new Date() },
    });
    if (claim.count !== 1) {
      throw new GoneException({ code: 'already_used', message: 'Pairing code already used.' });
    }

    // Mint the coach-bound session via the shared /auth/extension token
    // authority (R80) — no parallel token surface here.
    const tokens = await this.auth.mintExtensionSessionForCoach(row.coach_id);
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      chosen_platform: row.chosen_platform,
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
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return false;
  }
  return err.code === 'P2002';
}
