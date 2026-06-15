/**
 * RegimeRevisionRetentionService — rolling history eviction for named regimes.
 *
 * Operator decision (F2 brief §7): a regime keeps the "last 2 versions plus the
 * new one" = a rolling 3-deep WorkoutProgramRevision history. The depth is
 * stored per-program on `WorkoutProgram.revision_retention_count` (default 3)
 * so an operator can widen it later without a code change.
 *
 * Eviction runs AFTER a new WorkoutProgramRevision row commits, and ONLY for
 * programs flagged `is_regime=true` — raw workout-builder programs keep their
 * existing autosave/undo retention (owned by WorkoutBuilderRevisionPruneCron),
 * which this service never touches.
 *
 * Idempotency: eviction deletes every revision whose `revision_index` is below
 * `(maxIndex - retention + 1)`. Re-running on the same state is a no-op
 * (nothing left below the threshold), so a retried save cannot over-delete.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

// Accepts either the live PrismaService or a Prisma.TransactionClient so the
// eviction can ride the same transaction as the revision insert when a caller
// has one open.
type TxOrPrisma = Pick<PrismaService, 'workoutProgram' | 'workoutProgramRevision'>;

@Injectable()
export class RegimeRevisionRetentionService {
  private readonly logger = new Logger(RegimeRevisionRetentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Evict stale WorkoutProgramRevision rows for a regime, keeping only the
   * latest `revision_retention_count` by `revision_index`.
   *
   * No-op (returns 0) when:
   *   - the program does not exist, or
   *   - the program is not a regime (`is_regime=false`), or
   *   - the retained window already covers all existing revisions.
   *
   * @param programId  WorkoutProgram id whose revisions to prune.
   * @param tx         optional transaction client to ride the caller's tx.
   * @returns number of revision rows deleted.
   */
  async evictForRegime(
    programId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const db: TxOrPrisma = (tx as unknown as TxOrPrisma) ?? this.prisma;

    const program = await db.workoutProgram.findUnique({
      where: { id: programId },
      select: { id: true, is_regime: true, revision_retention_count: true },
    });

    // Only regimes participate in rolling-history eviction. Raw programs keep
    // their existing retention untouched.
    if (!program || !program.is_regime) return 0;

    // A retention <= 0 would be a misconfiguration; clamp to keep at least 1 so
    // we never wipe the entire history.
    const retention = Math.max(1, program.revision_retention_count);

    const newest = await db.workoutProgramRevision.findFirst({
      where: { program_id: programId },
      orderBy: { revision_index: 'desc' },
      select: { revision_index: true },
    });
    if (!newest) return 0;

    // Keep indices in [threshold, maxIndex]; delete everything below threshold.
    const threshold = newest.revision_index - retention + 1;
    if (threshold <= 0) return 0;

    const result = await db.workoutProgramRevision.deleteMany({
      where: {
        program_id: programId,
        revision_index: { lt: threshold },
      },
    });

    if (result.count > 0) {
      this.logger.log(
        `evictForRegime: pruned ${result.count} revision(s) for regime=${programId} (kept latest ${retention})`,
      );
    }
    return result.count;
  }
}
