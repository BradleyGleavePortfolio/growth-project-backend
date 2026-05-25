import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma.service';

// nanoid-style URL-safe alphabet — 57 unambiguous characters. Drops the
// look-alike pairs (0/O, 1/I/l) so a coach can read a share link aloud
// without misreads. 10 chars × 57 = ~57^10 ≈ 4.8e17 — collision is a
// non-event but the service still retries up to 5 times on the @unique
// constraint for full defence-in-depth.
const ALPHABET =
  '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
const TOKEN_LENGTH = 10;
const MAX_COLLISION_ATTEMPTS = 5;

function mintToken(): string {
  let out = '';
  for (let i = 0; i < TOKEN_LENGTH; i += 1) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
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
  async mintOrGet(
    coachUserId: string,
    packageId: string,
  ): Promise<ShareLinkResult> {
    const pkg = await this.prisma.coachPackage.findUnique({
      where: { id: packageId },
      select: {
        id: true,
        coach_id: true,
        archived_at: true,
        share_token: true,
        share_link_enabled: true,
        share_link_generated_at: true,
      },
    });

    if (!pkg || pkg.coach_id !== coachUserId || pkg.archived_at !== null) {
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
      // which.
      const reread = await this.prisma.coachPackage.findUnique({
        where: { id: packageId },
        select: {
          coach_id: true,
          archived_at: true,
          share_token: true,
          share_link_enabled: true,
          share_link_generated_at: true,
        },
      });
      if (
        !reread ||
        reread.coach_id !== coachUserId ||
        reread.archived_at !== null
      ) {
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

    // 57^10 ≈ 4.8e17 — five consecutive collisions implies either a
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
    const base =
      this.config.get<string>('STOREFRONT_BASE_URL') ?? 'https://tgp.app';
    return {
      share_token: token,
      share_url: `${base.replace(/\/$/, '')}/join/${token}`,
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
