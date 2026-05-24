/**
 * MarketplaceIdempotencyService — Phase 11 / Track 8
 *
 * Per-route idempotency ledger for talent-marketplace mutations. Audit #2 P1-1
 * called out that reusing a single `idempotency_key` column on CoachOffer for
 * create / accept / reject was unsafe: a later accept or reject would overwrite
 * the create key, breaking permanent replay of the original POST.
 *
 * This service exposes the standard `replayOrRun` pattern:
 *
 *   const replay = await idem.findReplay(userId, route, key);
 *   if (replay) return replay;
 *   const result = await doTheWork();
 *   await idem.record(userId, route, key, result);
 *   return result;
 *
 * A concurrent insert losing the unique-constraint race on
 * (user_id, route_key, idempotency_key) is caught and resolved to the winning
 * row, so two simultaneous retries cannot both perform the underlying work.
 *
 * Scope: marketplace mutations only. Other modules continue to use their own
 * inline idempotency_key columns where the legacy pattern is still safe.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

export type IdempotencyRouteKey =
  | 'admin.application.review'
  | 'talent.connect.onboarding-link'
  | 'talent.offers.accept'
  | 'talent.offers.reject';

@Injectable()
export class MarketplaceIdempotencyService {
  private readonly logger = new Logger(MarketplaceIdempotencyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Look up a previously cached response for (user_id, route_key, key). Returns
   * the cached JSON when present, or null when this is a first-time request.
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
      select: { response: true },
    });
    if (!row) return null;
    return row.response as T;
  }

  /**
   * Record the response for a successful first-time mutation. If a concurrent
   * caller already wrote the same key, the unique-constraint race surfaces as
   * P2002; we swallow it and return the cached row (the persisted response
   * may differ in trivial detail, but the contract guarantees one execution).
   *
   * The `response` parameter is typed as `unknown` so callers don't have to
   * cast service-layer return shapes through Prisma's `InputJsonValue` type;
   * we serialise via JSON.parse(JSON.stringify(...)) so Date fields land as
   * ISO strings and class instances are flattened to plain objects.
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
          response: serialised,
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
}
