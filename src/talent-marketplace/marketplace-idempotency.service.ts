/**
 * MarketplaceIdempotencyService — Phase 11 / Track 8
 *
 * Per-route idempotency ledger for talent-marketplace mutations. Audit #4 P1-1
 * upgraded this to an *atomic claim* pattern: the previous check-then-act flow
 * (findReplay → mutate → record) was not concurrency-safe because two
 * simultaneous same-key requests could both observe an empty ledger and both
 * run the mutation body. The loser then surfaced a user-visible 409 instead
 * of replaying the original successful response, violating R19/F28/F29/F44.
 *
 * New pattern used by callers:
 *
 *   const claim = await idem.claimOrReplay(userId, route, key);
 *   if (!claim.claimed) {
 *     if (claim.status === 'completed' && claim.response) return claim.response;
 *     throw new ConflictException('Request is already being processed. Retry in a moment.');
 *   }
 *   try {
 *     const result = await doTheWork();
 *     await idem.markCompleted(userId, route, key, result);
 *     return result;
 *   } catch (e) {
 *     // best-effort: clear the claim so retries can re-attempt the mutation
 *     await idem.releaseClaim(userId, route, key);
 *     throw e;
 *   }
 *
 * `claimOrReplay` inserts an `in_progress` row first. If the unique-constraint
 * race fires (P2002), the caller lost — we read the winning row and report its
 * status so the caller can decide between "replay" and "still in progress".
 *
 * Scope: marketplace mutations only. The legacy `findReplay` / `record`
 * methods are retained for any caller that still uses the old pattern, but new
 * code should use `claimOrReplay` + `markCompleted` + `releaseClaim`.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

export type IdempotencyRouteKey =
  | 'admin.application.review'
  | 'talent.connect.onboarding-link'
  | 'talent.offers.accept'
  | 'talent.offers.reject';

export type ClaimStatus = 'in_progress' | 'completed';

export type ClaimResult<T = unknown> =
  | { claimed: true }
  | { claimed: false; status: ClaimStatus; response: T | null };

@Injectable()
export class MarketplaceIdempotencyService {
  private readonly logger = new Logger(MarketplaceIdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically claim `(user_id, route_key, idempotency_key)` for execution.
   *
   * - On success: returns `{ claimed: true }`. Caller runs the mutation and
   *   then calls `markCompleted` (success) or `releaseClaim` (failure).
   * - On lost race (P2002): returns `{ claimed: false, status, response }` from
   *   the winning row. Caller replays `response` if status is `completed`, or
   *   surfaces a 409 if status is `in_progress` (the original request has not
   *   finished yet — retrying after a moment will hit the replay path).
   */
  async claimOrReplay<T = unknown>(
    userId: string,
    routeKey: IdempotencyRouteKey,
    idempotencyKey: string,
  ): Promise<ClaimResult<T>> {
    try {
      await this.prisma.marketplaceMutationIdempotency.create({
        data: {
          user_id: userId,
          route_key: routeKey,
          idempotency_key: idempotencyKey,
          status: 'in_progress',
          response: Prisma.JsonNull,
        },
      });
      return { claimed: true };
    } catch (err) {
      if (!this.isUniqueViolation(err)) throw err;
      const existing = await this.prisma.marketplaceMutationIdempotency.findUnique({
        where: {
          user_id_route_key_idempotency_key: {
            user_id: userId,
            route_key: routeKey,
            idempotency_key: idempotencyKey,
          },
        },
        select: { status: true, response: true },
      });
      const status: ClaimStatus =
        (existing?.status as ClaimStatus | undefined) ?? 'in_progress';
      const response = (existing?.response ?? null) as T | null;
      this.logger.warn(
        `Lost idempotency claim race for ${routeKey}/${userId} (status=${status})`,
      );
      return { claimed: false, status, response };
    }
  }

  /**
   * Mark a previously-claimed row `completed` and persist the response. The
   * `response` parameter is typed as `unknown` so callers don't have to cast
   * service-layer return shapes through Prisma's `InputJsonValue` type; we
   * serialise via JSON.parse(JSON.stringify(...)) so Date fields land as ISO
   * strings and class instances are flattened to plain objects.
   */
  async markCompleted<T>(
    userId: string,
    routeKey: IdempotencyRouteKey,
    idempotencyKey: string,
    response: T,
  ): Promise<void> {
    const serialised = JSON.parse(JSON.stringify(response)) as Prisma.InputJsonValue;
    await this.prisma.marketplaceMutationIdempotency.update({
      where: {
        user_id_route_key_idempotency_key: {
          user_id: userId,
          route_key: routeKey,
          idempotency_key: idempotencyKey,
        },
      },
      data: {
        status: 'completed',
        response: serialised,
        completed_at: new Date(),
      },
    });
  }

  /**
   * Best-effort: delete an in-progress claim row so a subsequent retry can
   * re-attempt the mutation. Called when the mutation body throws. Swallows
   * its own errors — a stale `in_progress` row will time out via operational
   * cleanup rather than block the failure path.
   */
  async releaseClaim(
    userId: string,
    routeKey: IdempotencyRouteKey,
    idempotencyKey: string,
  ): Promise<void> {
    try {
      await this.prisma.marketplaceMutationIdempotency.delete({
        where: {
          user_id_route_key_idempotency_key: {
            user_id: userId,
            route_key: routeKey,
            idempotency_key: idempotencyKey,
          },
        },
      });
    } catch (err) {
      this.logger.warn(
        `releaseClaim failed for ${routeKey}/${userId}: ${this.errorMessage(err)}`,
      );
    }
  }

  /**
   * Legacy read-then-write API — retained for back-compat with any caller
   * still on the old pattern. New code should use `claimOrReplay`.
   */
  async findReplay<T = unknown>(
    userId: string,
    routeKey: IdempotencyRouteKey,
    idempotencyKey: string,
  ): Promise<T | null> {
    const row = await this.prisma.marketplaceMutationIdempotency.findUnique({
      where: {
        user_id_route_key_idempotency_key: {
          user_id: userId,
          route_key: routeKey,
          idempotency_key: idempotencyKey,
        },
      },
      select: { status: true, response: true },
    });
    if (!row || row.status !== 'completed') return null;
    return (row.response ?? null) as T | null;
  }

  /**
   * Legacy write-after-work API — retained for back-compat. New code should
   * use `claimOrReplay` + `markCompleted` so the claim is atomic.
   */
  async record<T>(
    userId: string,
    routeKey: IdempotencyRouteKey,
    idempotencyKey: string,
    response: T,
  ): Promise<T> {
    const serialised = JSON.parse(JSON.stringify(response)) as Prisma.InputJsonValue;
    try {
      await this.prisma.marketplaceMutationIdempotency.create({
        data: {
          user_id: userId,
          route_key: routeKey,
          idempotency_key: idempotencyKey,
          status: 'completed',
          response: serialised,
          completed_at: new Date(),
        },
      });
      return response;
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        const cached = await this.findReplay<T>(userId, routeKey, idempotencyKey);
        if (cached !== null) {
          this.logger.warn(
            `Lost idempotency-ledger race for ${routeKey}/${userId}; returning cached response`,
          );
          return cached;
        }
      }
      throw err;
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === 'P2002'
    );
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}
