import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

/**
 * TTL after which a still-`pending` claim is treated as abandoned and may be
 * reclaimed by a fresh request. This FIXES P1-8: the legacy `714a69af` impl
 * swallowed releaseClaim errors and relied on non-existent "operational
 * cleanup", so a crash mid-mutation left a `pending` row that blocked every
 * future replay of that (user, route, key) forever. The staleness sweep inside
 * claimOrReplay makes such a row reclaimable once it is older than the TTL.
 *
 * Configurable via MARKETPLACE_IDEMPOTENCY_CLAIM_TTL_MS. Documented fallback
 * default: 600000ms (10 minutes) — comfortably longer than any marketplace
 * mutation, short enough that a crashed claim self-heals within one retry cycle.
 */
const CLAIM_TTL_FALLBACK_MS = 600_000;

function resolveClaimTtlMs(): number {
  const raw = process.env.MARKETPLACE_IDEMPOTENCY_CLAIM_TTL_MS;
  if (raw === undefined || raw === '') {
    return CLAIM_TTL_FALLBACK_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return CLAIM_TTL_FALLBACK_MS;
  }
  return parsed;
}

export const MARKETPLACE_CLAIM_STATUS_PENDING = 'pending';
export const MARKETPLACE_CLAIM_STATUS_COMPLETED = 'completed';

interface ClaimKey {
  userId: string;
  routeKey: string;
  idempotencyKey: string;
}

export type ClaimOrReplayResult =
  | { outcome: 'claimed' }
  | { outcome: 'replay'; response: Prisma.JsonValue };

/**
 * MarketplaceIdempotencyService — per-route mutation idempotency ledger backed
 * by MarketplaceMutationIdempotency (composite unique on
 * (user_id, route_key, idempotency_key); RESTRICTIVE deny-all RLS with
 * service_role bypass set in TM-1).
 *
 * Contract:
 *   - claimOrReplay: atomically claim a (user, route, key) by inserting a
 *     `pending` row. If a completed row already exists, return its stored
 *     response (replay). If a `pending` row exists but is older than the TTL,
 *     reclaim it (P1-8 staleness sweep). A fresh `pending` row that is within
 *     the TTL means a sibling request is genuinely in flight — surface that to
 *     the caller rather than double-executing.
 *   - markCompleted: persist the response and flip the claim to `completed`.
 *   - releaseClaim: delete the caller's `pending` claim after a mutation error
 *     so a corrected retry can proceed. Errors are surfaced (R70 fail-fast),
 *     never swallowed — that swallow was the root cause of P1-8.
 */
@Injectable()
export class MarketplaceIdempotencyService {
  private readonly logger = new Logger(MarketplaceIdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  async claimOrReplay(key: ClaimKey): Promise<ClaimOrReplayResult> {
    const { userId, routeKey, idempotencyKey } = key;

    try {
      await this.prisma.marketplaceMutationIdempotency.create({
        data: {
          user_id: userId,
          route_key: routeKey,
          idempotency_key: idempotencyKey,
          status: MARKETPLACE_CLAIM_STATUS_PENDING,
          response: Prisma.JsonNull,
        },
      });
      return { outcome: 'claimed' };
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== 'P2002'
      ) {
        throw err;
      }
      // Lost the unique-index race — an existing row owns this key. Decide
      // between replay (completed), in-flight (fresh pending), or reclaim
      // (stale pending) below.
    }

    const existing =
      await this.prisma.marketplaceMutationIdempotency.findUnique({
        where: {
          user_id_route_key_idempotency_key: {
            user_id: userId,
            route_key: routeKey,
            idempotency_key: idempotencyKey,
          },
        },
        select: { id: true, status: true, response: true, created_at: true },
      });

    if (!existing) {
      // Row vanished between the failed insert and this read — a concurrent
      // releaseClaim won the race. Treat as reclaimable: retry the claim once.
      return this.reclaim(key);
    }

    if (existing.status === MARKETPLACE_CLAIM_STATUS_COMPLETED) {
      return { outcome: 'replay', response: existing.response };
    }

    // status === pending. If it is older than the TTL the original owner is
    // presumed dead (P1-8). Atomically reclaim it; otherwise a sibling is
    // genuinely mid-flight and the caller must not re-execute.
    const ageMs = Date.now() - existing.created_at.getTime();
    if (ageMs <= resolveClaimTtlMs()) {
      this.logger.warn(
        `Active idempotency claim in flight for user=${userId} route=${routeKey}`,
      );
      return { outcome: 'replay', response: existing.response };
    }

    return this.reclaimStale(key, existing.id);
  }

  async markCompleted(
    key: ClaimKey,
    response: Prisma.InputJsonValue,
  ): Promise<void> {
    const { userId, routeKey, idempotencyKey } = key;
    await this.prisma.marketplaceMutationIdempotency.update({
      where: {
        user_id_route_key_idempotency_key: {
          user_id: userId,
          route_key: routeKey,
          idempotency_key: idempotencyKey,
        },
      },
      data: {
        status: MARKETPLACE_CLAIM_STATUS_COMPLETED,
        response,
        completed_at: new Date(),
      },
    });
  }

  async releaseClaim(key: ClaimKey): Promise<void> {
    const { userId, routeKey, idempotencyKey } = key;
    // Fail-fast (R70): a failed release is the exact bug that produced P1-8.
    // Surface the error so the caller (and alerting) sees a stuck claim instead
    // of silently leaving a row that blocks every future replay.
    await this.prisma.marketplaceMutationIdempotency.delete({
      where: {
        user_id_route_key_idempotency_key: {
          user_id: userId,
          route_key: routeKey,
          idempotency_key: idempotencyKey,
        },
      },
    });
  }

  /** Re-attempt the claim after the prior row disappeared concurrently. */
  private async reclaim(key: ClaimKey): Promise<ClaimOrReplayResult> {
    const { userId, routeKey, idempotencyKey } = key;
    await this.prisma.marketplaceMutationIdempotency.create({
      data: {
        user_id: userId,
        route_key: routeKey,
        idempotency_key: idempotencyKey,
        status: MARKETPLACE_CLAIM_STATUS_PENDING,
        response: Prisma.JsonNull,
      },
    });
    return { outcome: 'claimed' };
  }

  /**
   * Reclaim a stale `pending` row by id, guarding on status so we only take it
   * if it is still pending (a concurrent reclaim/complete loses harmlessly).
   */
  private async reclaimStale(
    key: ClaimKey,
    rowId: string,
  ): Promise<ClaimOrReplayResult> {
    const reclaimed =
      await this.prisma.marketplaceMutationIdempotency.updateMany({
        where: { id: rowId, status: MARKETPLACE_CLAIM_STATUS_PENDING },
        data: {
          status: MARKETPLACE_CLAIM_STATUS_PENDING,
          response: Prisma.JsonNull,
          created_at: new Date(),
          completed_at: null,
        },
      });
    if (reclaimed.count === 0) {
      // Another request reclaimed or completed it first — re-read and replay.
      return this.claimOrReplay(key);
    }
    this.logger.warn(
      `Reclaimed stale idempotency claim user=${key.userId} route=${key.routeKey} (P1-8 sweep)`,
    );
    return { outcome: 'claimed' };
  }
}
