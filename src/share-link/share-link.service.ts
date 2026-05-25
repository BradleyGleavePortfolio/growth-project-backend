import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma.service';
import { parseStorefrontBaseUrl } from '../common/env-validation';

// P1-3 — share-link tokens are now 21 characters drawn from the standard
// nanoid alphabet (A-Z, a-z, 0-9, '_', '-'). 21 × log2(64) ≈ 126 bits of
// entropy; the previous 10-char alphabet (~58 bits) was far below the
// minimum the audit brief calls out for an anonymous public lookup
// endpoint. A targeted migration re-mints any legacy 10-char token to a
// 21-char one before this code path goes live, so legacy links keep
// resolving — see prisma/migrations/.../guest_checkout_retryable_*.
const TOKEN_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
export const SHARE_TOKEN_LENGTH = 21;
// Exported so the controller param parser and the storefront service can
// share one source of truth — defence-in-depth: a malformed token never
// reaches Prisma.
export const SHARE_TOKEN_REGEX = /^[A-Za-z0-9_-]{21}$/;
const MAX_COLLISION_ATTEMPTS = 5;

// Dev/test fallback used when STOREFRONT_BASE_URL is unset. Production
// must set the env var explicitly (enforced in prodHardenedFeatureVars
// inside env-validation.ts). The fallback is the canonical
// joingrowthproject.com domain; no other domain is permitted.
const STOREFRONT_BASE_URL_DEV_FALLBACK = 'https://joingrowthproject.com';

function mintToken(): string {
  // randomBytes draws from /dev/urandom (libuv) — a CSPRNG. We then
  // map each byte into the nanoid alphabet by masking to 6 bits and
  // rejecting bytes whose 6-bit value lands outside the alphabet (which
  // here has length 64 exactly, so no rejection is needed — but we keep
  // the masking pattern so a future alphabet change does not silently
  // bias the output).
  const buf = randomBytes(SHARE_TOKEN_LENGTH);
  let out = '';
  for (let i = 0; i < SHARE_TOKEN_LENGTH; i += 1) {
    out += TOKEN_ALPHABET[buf[i] & 63];
  }
  return out;
}

export interface ShareLinkResult {
  share_token: string;
  share_url: string;
  share_link_enabled: boolean;
  share_link_generated_at: Date;
}

@Injectable()
export class ShareLinkService {
  private readonly logger = new Logger(ShareLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // Mint or return the existing share_token for a package owned by
  // coachUserId. Returns 404 (not 403) when the package is missing, has a
  // different owner, or is archived — refusing to differentiate prevents
  // ID enumeration via guessable UUIDs.
  //
  // P2-2 — the initial read is tenant-scoped: another coach's package
  // UUID never returns a row to application code, so we cannot leak that
  // the row exists by timing or by a downstream join.
  async mintOrGet(
    coachUserId: string,
    packageId: string,
  ): Promise<ShareLinkResult> {
    const pkg = await this.prisma.coachPackage.findFirst({
      where: {
        id: packageId,
        coach_id: coachUserId,
        archived_at: null,
      },
      select: {
        id: true,
        share_token: true,
        share_link_enabled: true,
        share_link_generated_at: true,
      },
    });

    if (!pkg) {
      throw new NotFoundException({
        error: 'PACKAGE_NOT_FOUND',
        message: 'Package not found.',
      });
    }

    // Idempotent path: token already minted — return as-is without
    // touching the DB. share_link_enabled is whatever the coach last set
    // (paused links round-trip through the same return shape).
    if (pkg.share_token && pkg.share_link_generated_at) {
      return this.buildResult(
        pkg.share_token,
        pkg.share_link_enabled,
        pkg.share_link_generated_at,
      );
    }

    // P1-2 — mint atomically. The previous implementation did
    //   read → check share_token is null → mint → update by id
    // which let two concurrent callers both observe share_token = null,
    // mint two different tokens, and have the later UPDATE overwrite the
    // earlier — handing the first caller a dead token.
    //
    // The fix is a conditional updateMany whose WHERE includes
    // share_token: null. Only one writer can win that race; everyone else
    // sees count = 0 and re-reads the winning token.
    for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
      const candidate = mintToken();
      const now = new Date();
      let updateCount: number;
      try {
        const result = await this.prisma.coachPackage.updateMany({
          where: {
            id: packageId,
            coach_id: coachUserId,
            archived_at: null,
            share_token: null,
          },
          data: {
            share_token: candidate,
            share_link_enabled: true,
            share_link_generated_at: now,
          },
        });
        updateCount = result.count;
      } catch (err) {
        // P2002 on share_token@unique — another package took this
        // candidate. Retry with a fresh candidate.
        if (this.isUniqueViolation(err)) {
          this.logger.warn(
            `share_token collision on attempt ${attempt + 1} for package ${packageId}`,
          );
          continue;
        }
        throw err;
      }

      if (updateCount === 1) {
        // We won the race — our candidate is now persisted.
        return this.buildResult(candidate, true, now);
      }

      // count = 0 means either (a) a concurrent caller already minted a
      // token (share_token is no longer null), or (b) the package was
      // archived between our find and our update. Re-read to find out
      // which — tenant-scoped again so we never leak another coach's
      // row even if the package id was guessed.
      const reread = await this.prisma.coachPackage.findFirst({
        where: {
          id: packageId,
          coach_id: coachUserId,
          archived_at: null,
        },
        select: {
          share_token: true,
          share_link_enabled: true,
          share_link_generated_at: true,
        },
      });
      if (!reread) {
        throw new NotFoundException({
          error: 'PACKAGE_NOT_FOUND',
          message: 'Package not found.',
        });
      }
      if (reread.share_token && reread.share_link_generated_at) {
        // Another concurrent request won — return its token. Never
        // overwrite an existing share_token.
        return this.buildResult(
          reread.share_token,
          reread.share_link_enabled,
          reread.share_link_generated_at,
        );
      }
      // share_token is still null somehow (very rare — likely the row
      // was just unarchived). Loop and try again.
    }

    // 64^21 ≈ 8.5e37 — five consecutive collisions implies either a
    // catastrophic RNG failure or a poisoned alphabet. 503 rather than
    // 500 so the caller can present a retriable error.
    this.logger.error(
      `Failed to mint unique share_token after ${MAX_COLLISION_ATTEMPTS} attempts for package ${packageId}`,
    );
    throw new ServiceUnavailableException({
      error: 'SHARE_LINK_UNAVAILABLE',
      message: 'Could not generate a share link. Please try again.',
    });
  }

  private buildResult(
    token: string,
    enabled: boolean,
    generatedAt: Date,
  ): ShareLinkResult {
    const raw = this.config.get<string>('STOREFRONT_BASE_URL');
    const parsed = parseStorefrontBaseUrl(
      raw && raw.trim().length > 0 ? raw : STOREFRONT_BASE_URL_DEV_FALLBACK,
    );
    const base = parsed.ok ? parsed.canonical : STOREFRONT_BASE_URL_DEV_FALLBACK;
    return {
      share_token: token,
      share_url: `${base}/join/${token}`,
      share_link_enabled: enabled,
      share_link_generated_at: generatedAt,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { code?: string; message?: string };
    if (e.code === 'P2002') return true;
    return (
      typeof e.message === 'string' && /unique constraint/i.test(e.message)
    );
  }
}
