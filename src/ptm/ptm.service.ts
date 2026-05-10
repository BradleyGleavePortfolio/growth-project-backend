import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import type { RecordSignalInput, PtmSignalTypeT } from './ptm.types';

/**
 * PtmService — the single fire-and-forget entry point for behavioral
 * signal collection. Phase 1A.
 *
 * Doctrine:
 *   * Every call to recordSignal is fire-and-forget at the call site.
 *     The service catches and logs every failure; a PTM table outage
 *     MUST NEVER bubble back into a user-facing 5xx.
 *   * ClientSignal is APPEND-ONLY. We never UPDATE a signal in place —
 *     corrections are a fresh row. This preserves the audit trail and
 *     lets the heuristic engine reconstruct any historical window.
 *   * value defaults to 1.0 (boolean event) so call sites that just
 *     want to record "this happened" can omit it. metadata is optional
 *     and must NEVER carry PII (no emails, names, message bodies).
 *
 * The heuristic engine (Phase 1B), the weighted engine (Phase 1D), and
 * the admin teaching surface (Phase 1C) layer on top of this service —
 * each in its own file. This file deliberately stays small.
 */
@Injectable()
export class PtmService {
  private readonly logger = new Logger(PtmService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a single behavioral signal. Fire-and-forget.
   *
   * Returns void so the caller's await is purely a sequencing nicety —
   * even if the await rejects (it never does; we catch internally), the
   * caller's request path is untouched. In practice we recommend not
   * awaiting at all; see the convenience helper `emit()` below.
   */
  async recordSignal(input: RecordSignalInput): Promise<void> {
    try {
      await this.prisma.clientSignal.create({
        data: {
          user_id: input.userId,
          signal_type: input.signalType,
          value: input.value ?? 1,
          metadata:
            input.metadata != null
              ? (input.metadata as Prisma.InputJsonValue)
              : Prisma.DbNull,
          ...(input.recordedAt ? { recorded_at: input.recordedAt } : {}),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `PTM signal write failed (user=${input.userId} type=${input.signalType}): ${msg}`,
      );
    }
  }

  /**
   * Convenience wrapper. Drop-in for module call sites:
   *
   * ```ts
   * this.ptm.emit(userId, 'workout_logged', volumeKg, { exercise_count });
   * ```
   *
   * This call returns immediately — the signal write is dispatched on
   * the microtask queue and any failure is logged. The intent is that
   * a check-in / weight / message handler never has to think about
   * whether to await.
   */
  emit(
    userId: string,
    signalType: PtmSignalTypeT,
    value?: number,
    metadata?: Record<string, unknown>,
  ): void {
    // Fire-and-forget: schedule the write but do not await it. The
    // returned Promise is intentionally unhandled because recordSignal
    // never throws (it catches internally).
    void this.recordSignal({ userId, signalType, value, metadata });
  }

  /**
   * Read the most recent prediction row for a user. Used by the admin
   * dashboard, the coach risk board, and the recompute service when it
   * needs the prior score for delta tracking.
   *
   * Returns null when the user has never been scored — the caller must
   * decide whether to render "Not yet scored" or trigger a recompute.
   */
  async getLatestPrediction(userId: string) {
    return this.prisma.ptmPrediction.findFirst({
      where: { user_id: userId },
      orderBy: { computed_at: 'desc' },
    });
  }

  /**
   * List historical predictions for a user, newest-first. Bounded to
   * the last `limit` rows (default 60, max 365) so a long-tenured
   * client doesn't cause a runaway query. Surfaced by the admin
   * "score history" drawer.
   */
  async listPredictionHistory(userId: string, limit = 60) {
    const clamped = Math.min(Math.max(limit, 1), 365);
    return this.prisma.ptmPrediction.findMany({
      where: { user_id: userId },
      orderBy: { computed_at: 'desc' },
      take: clamped,
    });
  }
}
