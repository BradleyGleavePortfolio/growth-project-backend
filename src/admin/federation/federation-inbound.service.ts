import {
  Injectable,
  Logger,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma.service';
import { PtmService } from '../../ptm/ptm.service';
import { InboundSignalDto, ALLOWED_FINANCE_SIGNAL_TYPES } from './federation-inbound.dto';

/**
 * Constant-time bearer-token compare. Falls back to a length-equality
 * precheck so `timingSafeEqual` never sees mismatched buffer lengths
 * (which would throw rather than return false). The precheck itself
 * is constant time over the inputs supplied — both lengths are read
 * once each. Audit fix Coach #6.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * FederationInboundService — validates service-token auth and dispatches
 * inbound finance signals to PtmService.
 *
 * Auth flow (fail-closed at each step):
 *
 *   1. `FINANCE_SERVICE_TOKEN` unset → 503 FEDERATION_DISABLED. The
 *      endpoint is open by path (`@Public()`) but closed by config until
 *      the operator explicitly sets the token.
 *   2. Bearer token missing or mismatch → 401 FEDERATION_UNAUTHENTICATED.
 *   3. `X-Federation-Source` header not `finance-backend` → 403
 *      FEDERATION_SOURCE_MISMATCH. Both checks must pass independently;
 *      a valid token from a non-finance caller is still rejected.
 *   4. `signal_type` not in the accepted finance signal set → 400
 *      SIGNAL_TYPE_NOT_ACCEPTED. (DTO validation catches unknown types
 *      first; this is a belt-and-suspenders guard for any bypass.)
 *   5. Neither `user_id` nor `email` provided → 400 MISSING_IDENTITY.
 *   6. User not found in fitness database → 404 USER_NOT_FOUND.
 *   7. PTM emit (fire-and-forget) → returns `{ ok: true }` immediately.
 */
@Injectable()
export class FederationInboundService {
  private readonly logger = new Logger(FederationInboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ptm: PtmService,
  ) {}

  async handleSignal(
    authHeader: string | undefined,
    sourceHeader: string | undefined,
    dto: InboundSignalDto,
  ): Promise<{ ok: true }> {
    // --- Step 1: config gate ---
    const configuredToken = process.env.FINANCE_SERVICE_TOKEN?.trim();
    if (!configuredToken) {
      this.logger.warn(
        'Federation inbound: FINANCE_SERVICE_TOKEN is unset — rejecting with 503',
      );
      throw new ServiceUnavailableException('FEDERATION_DISABLED');
    }

    // --- Step 2: bearer token (constant-time compare, audit fix Coach #6) ---
    const bearerToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : undefined;
    if (!bearerToken || !constantTimeEqual(bearerToken, configuredToken)) {
      throw new UnauthorizedException('FEDERATION_UNAUTHENTICATED');
    }

    // --- Step 3: source header ---
    if (sourceHeader?.trim() !== 'finance-backend') {
      throw new ForbiddenException('FEDERATION_SOURCE_MISMATCH');
    }

    // --- Step 4: signal type belt-and-suspenders ---
    if (!ALLOWED_FINANCE_SIGNAL_TYPES.includes(dto.signal_type as any)) {
      throw new BadRequestException('SIGNAL_TYPE_NOT_ACCEPTED');
    }

    // --- Step 5: identity ---
    if (!dto.user_id && !dto.email) {
      throw new BadRequestException(
        'MISSING_IDENTITY: provide user_id or email',
      );
    }

    // --- Step 6: user lookup ---
    let userId: string;
    if (dto.user_id) {
      const user = await this.prisma.user.findUnique({
        where: { id: dto.user_id },
        select: { id: true, deleted_at: true },
      });
      if (!user || user.deleted_at) {
        throw new NotFoundException('USER_NOT_FOUND');
      }
      userId = user.id;
    } else {
      const email = dto.email!.trim().toLowerCase();
      const rows = await this.prisma.user.findMany({
        where: {
          email: { equals: email, mode: 'insensitive' },
          deleted_at: null,
        },
        take: 1,
        select: { id: true },
      });
      if (!rows.length) {
        throw new NotFoundException('USER_NOT_FOUND');
      }
      userId = rows[0].id;
    }

    // --- Step 7: fire-and-forget PTM emit ---
    // When `recorded_at` is supplied we use the lower-level `recordSignal`
    // (which accepts an explicit timestamp); otherwise the convenience
    // `emit` wrapper is sufficient.
    const sharedMetadata: Record<string, unknown> = {
      source: 'finance_federation',
      ...(dto.metadata ?? {}),
    };

    if (dto.recorded_at) {
      void this.ptm.recordSignal({
        userId,
        signalType: dto.signal_type,
        value: dto.value ?? 1,
        metadata: sharedMetadata,
        recordedAt: new Date(dto.recorded_at),
      });
    } else {
      this.ptm.emit(userId, dto.signal_type, dto.value ?? 1, sharedMetadata);
    }

    return { ok: true };
  }
}
