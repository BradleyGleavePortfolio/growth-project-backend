import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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

/**
 * Outcome of claimOrReplay — a discriminated union the caller MUST switch on:
 *
 *   - claimed:   the caller now owns the claim and must execute the mutation,
 *                then call markCompleted/releaseClaim with `claimNonce`. The
 *                nonce is a fencing token: a stale owner that was reclaimed
 *                holds an OLD nonce and its completion is rejected, so the same
 *                mutation never runs twice (F1).
 *   - replay:    a `completed` row with a real stored response already exists;
 *                return it verbatim without re-executing. Only ever produced
 *                once a genuine completed response exists (F2) — never for an
 *                in-flight pending row.
 *   - in_flight: a sibling request claimed this (user, route, key) within the
 *                TTL and is genuinely mid-flight. The caller must NOT execute
 *                and should surface a retryable conflict (F2) rather than a
 *                bogus success.
 */
export type ClaimOrReplayResult =
  | { outcome: 'claimed'; claimNonce: string }
  | { outcome: 'replay'; response: Prisma.JsonValue }
  | { outcome: 'in_flight' };

/**
 * Result of a fencing-guarded write (markCompleted / releaseClaim). `ok` when
 * the caller still owned the claim; `conflict` when the claim was reclaimed
 * out from under them (their nonce no longer matches). A conflict is NEVER a
 * silent blind write — the caller learns their mutation lost the claim.
 */
export type ClaimWriteResult = { outcome: 'ok' } | { outcome: 'conflict' };

/**
 * MarketplaceIdempotencyService — per-route mutation idempotency ledger backed
 * by MarketplaceMutationIdempotency (composite unique on
 * (user_id, route_key, idempotency_key); RESTRICTIVE deny-all RLS with
 * service_role bypass set in TM-1).
 *
 * Contract:
 *   - claimOrReplay: atomically claim a (user, route, key) by inserting a
 *     `pending` row stamped with a fresh fencing `claim_nonce`. If a completed
 *     row with a stored response already exists, replay it. If a `pending` row
 *     exists but is older than the TTL, reclaim it (P1-8 staleness sweep) and
 *     ROTATE the nonce so the dead owner is fenced (F1). A fresh `pending` row
 *     within the TTL means a sibling is genuinely in flight — return
 *     `in_flight` rather than double-executing (F2).
 *   - markCompleted: compare-and-set on `claim_nonce`. Persists the response
 *     and flips to `completed` ONLY if the caller still owns the claim. A
 *     reclaimed owner's completion is rejected as a typed conflict (F1) — never
 *     a silent blind update.
 *   - releaseClaim: compare-and-set delete of the caller's `pending` claim
 *     after a mutation error so a corrected retry can proceed. Guarded on
 *     `claim_nonce` so a reclaimed owner cannot delete the new owner's claim.
 */
@Injectable()
export class MarketplaceIdempotencyService {
  private readonly logger = new Logger(MarketplaceIdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  async claimOrReplay(key: ClaimKey): Promise<ClaimOrReplayResult> {
    const { userId, routeKey, idempotencyKey } = key;
    const claimNonce = randomUUID();

    try {
      await this.prisma.marketplaceMutationIdempotency.create({
        data: {
          user_id: userId,
          route_key: routeKey,
          idempotency_key: idempotencyKey,
          status: MARKETPLACE_CLAIM_STATUS_PENDING,
          response: Prisma.JsonNull,
          claim_nonce: claimNonce,
        },
      });
      return { outcome: 'claimed', claimNonce };
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
    // presumed dead (P1-8). Atomically reclaim it with a rotated nonce that
    // fences the dead owner; otherwise a sibling is genuinely mid-flight and
    // the caller must surface a retryable conflict rather than re-execute.
    const ageMs = Date.now() - existing.created_at.getTime();
    if (ageMs <= resolveClaimTtlMs()) {
      this.logger.warn(
        `Active idempotency claim in flight for user=${userId} route=${routeKey}`,
      );
      return { outcome: 'in_flight' };
    }

    return this.reclaimStale(key, existing.id);
  }

  /**
   * Persist the response and flip the claim to `completed` — but ONLY if the
   * caller still owns it (claim_nonce matches). Compare-and-set on the nonce
   * fences a reclaimed dead owner: its stale completion affects zero rows and
   * returns a typed conflict (F1) instead of blindly overwriting the live
   * owner's work.
   */
  async markCompleted(
    key: ClaimKey,
    claimNonce: string,
    response: Prisma.InputJsonValue,
  ): Promise<ClaimWriteResult> {
    const { userId, routeKey, idempotencyKey } = key;
    const updated =
      await this.prisma.marketplaceMutationIdempotency.updateMany({
        where: {
          user_id: userId,
          route_key: routeKey,
          idempotency_key: idempotencyKey,
          claim_nonce: claimNonce,
        },
        data: {
          status: MARKETPLACE_CLAIM_STATUS_COMPLETED,
          response,
          completed_at: new Date(),
        },
      });
    if (updated.count === 0) {
      this.logger.warn(
        `markCompleted rejected — claim reclaimed/lost for user=${userId} route=${routeKey}`,
      );
      return { outcome: 'conflict' };
    }
    return { outcome: 'ok' };
  }

  /**
   * Delete the caller's `pending` claim after a mutation error so a corrected
   * retry can proceed. Compare-and-set on claim_nonce so a reclaimed dead owner
   * cannot delete the NEW owner's live claim (F1). A failed delete still
   * surfaces (fail-fast / R70) — that swallow was the root cause of P1-8.
   */
  async releaseClaim(
    key: ClaimKey,
    claimNonce: string,
  ): Promise<ClaimWriteResult> {
    const { userId, routeKey, idempotencyKey } = key;
    const deleted =
      await this.prisma.marketplaceMutationIdempotency.deleteMany({
        where: {
          user_id: userId,
          route_key: routeKey,
          idempotency_key: idempotencyKey,
          claim_nonce: claimNonce,
        },
      });
    if (deleted.count === 0) {
      this.logger.warn(
        `releaseClaim no-op — claim reclaimed/lost for user=${userId} route=${routeKey}`,
      );
      return { outcome: 'conflict' };
    }
    return { outcome: 'ok' };
  }

  /** Re-attempt the claim after the prior row disappeared concurrently. */
  private async reclaim(key: ClaimKey): Promise<ClaimOrReplayResult> {
    const { userId, routeKey, idempotencyKey } = key;
    const claimNonce = randomUUID();
    await this.prisma.marketplaceMutationIdempotency.create({
      data: {
        user_id: userId,
        route_key: routeKey,
        idempotency_key: idempotencyKey,
        status: MARKETPLACE_CLAIM_STATUS_PENDING,
        response: Prisma.JsonNull,
        claim_nonce: claimNonce,
      },
    });
    return { outcome: 'claimed', claimNonce };
  }

  /**
   * Reclaim a stale `pending` row by id, guarding on status so we only take it
   * if it is still pending (a concurrent reclaim/complete loses harmlessly).
   * Rotates `claim_nonce` to a fresh value so the presumed-dead original owner
   * is fenced: its later markCompleted/releaseClaim no longer matches (F1).
   */
  private async reclaimStale(
    key: ClaimKey,
    rowId: string,
  ): Promise<ClaimOrReplayResult> {
    const claimNonce = randomUUID();
    const reclaimed =
      await this.prisma.marketplaceMutationIdempotency.updateMany({
        where: { id: rowId, status: MARKETPLACE_CLAIM_STATUS_PENDING },
        data: {
          status: MARKETPLACE_CLAIM_STATUS_PENDING,
          response: Prisma.JsonNull,
          created_at: new Date(),
          completed_at: null,
          claim_nonce: claimNonce,
        },
      });
    if (reclaimed.count === 0) {
      // Another request reclaimed or completed it first — re-read and replay
      // (or surface in_flight if the winner is still pending within the TTL).
      return this.claimOrReplay(key);
    }
    this.logger.warn(
      `Reclaimed stale idempotency claim user=${key.userId} route=${key.routeKey} (P1-8 sweep)`,
    );
    return { outcome: 'claimed', claimNonce };
  }
}
