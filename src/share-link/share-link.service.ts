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

    // Collision retry — we tolerate the @unique race that would otherwise
    // crash the request on a P2002. randomInt + 57-char alphabet over 10
    // positions means the loop almost always exits on the first attempt;
    // 5 is generous belt-and-braces.
    let token: string | null = null;
    for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
      const candidate = mintToken();
      const collision = await this.prisma.coachPackage.findUnique({
        where: { share_token: candidate },
        select: { id: true },
      });
      if (!collision) {
        token = candidate;
        break;
      }
      this.logger.warn(
        `share_token collision on attempt ${attempt + 1} for package ${packageId}`,
      );
    }

    if (!token) {
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

    const now = new Date();
    try {
      const updated = await this.prisma.coachPackage.update({
        where: { id: packageId },
        data: {
          share_token: token,
          share_link_generated_at: now,
        },
        select: {
          share_token: true,
          share_link_enabled: true,
          share_link_generated_at: true,
        },
      });
      return this.buildResult(
        updated.share_token!,
        updated.share_link_enabled,
        updated.share_link_generated_at!,
      );
    } catch (err) {
      // P2002 race: another concurrent call for the same package id beat
      // us to it. Re-read and return what's there — the token is opaque
      // to the coach so "you got the other call's token" is the same UX
      // as "you got your own". Re-throw anything else.
      if (this.isUniqueViolation(err)) {
        const reread = await this.prisma.coachPackage.findUnique({
          where: { id: packageId },
          select: {
            share_token: true,
            share_link_enabled: true,
            share_link_generated_at: true,
          },
        });
        if (reread?.share_token && reread.share_link_generated_at) {
          return this.buildResult(
            reread.share_token,
            reread.share_link_enabled,
            reread.share_link_generated_at,
          );
        }
      }
      throw err;
    }
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
