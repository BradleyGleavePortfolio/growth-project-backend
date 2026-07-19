import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { PrismaService } from '../prisma.service';
import {
  buildFamilyRegistry,
  type FamilyReconstructor,
  type StagedRow,
} from './reconstruct/families';
import {
  RECONSTRUCT_ENTITY_TYPE,
  RECONSTRUCT_MAX_ROWS,
  RECONSTRUCT_PAGE_SIZE,
  RECONSTRUCT_STATUS,
  type ScoutReconstructResult,
} from './scout-reconstruct.dto';

/**
 * IMPORTER-F + IMPORTER-H — reconstruct a settled crawl intent's staged entities
 * of one family into canonical records (D2, Op 59 + Op 63). The `clients` family
 * reconstructs into invite-pending, non-login, tenant-owned roster `Person`
 * records; non-person families (`workouts`, `client_history`) reconstruct into
 * the generic canonical `ScoutReconstructedEntity` table. The engine is keyed on
 * entity_type via a family registry — ONE parameterized mechanism, no cloned
 * pipelines.
 *
 * Guarantees (family-independent — the engine owns them, not the family):
 *  - Post-settle only: a still-running intent is rejected (no partial import).
 *  - Fail-closed family: an unregistered entity_type is a 400 before any read.
 *  - Bounded fan-out: staged rows are counted first, an over-ceiling intent is
 *    rejected fail-closed, and the rest are read one deterministic page at a
 *    time — never the whole roster at once and never an unbounded query burst.
 *  - Idempotent: the canonical target is keyed on the tenant-scoped external_ref
 *    and the ledger on (coach_id, intent_id, entity_type, source_id), both
 *    upserted, so a replay mints no new rows and returns identical counts. A
 *    concurrent replay that loses the insert race (unique violation) is retried
 *    once and converges, never a spurious `failed`.
 *  - Poison-row isolation: each staged row is reconstructed in its own
 *    transaction inside a try/catch; one bad row is recorded `failed` and its
 *    siblings still reconstruct.
 *  - Honest accounting: counts are read back from the durable ledger, so
 *    `staged === reconstructed + skipped + failed` always holds.
 *  - No credential is ever minted and email is never used as a key.
 */
@Injectable()
export class ScoutReconstructService {
  private readonly logger = new Logger(ScoutReconstructService.name);
  private readonly families = buildFamilyRegistry();

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  async reconstruct(
    coachId: string,
    intentId: string,
    entityType: string = RECONSTRUCT_ENTITY_TYPE,
  ): Promise<ScoutReconstructResult> {
    // Fail closed on an unknown family BEFORE any read or write, so a family the
    // engine cannot map (e.g. billing) can never leave a partial reconciliation.
    const family = this.families.get(entityType);
    if (!family) {
      throw new BadRequestException(`unsupported reconstruct family: ${entityType}`);
    }

    await this.assertSettled(coachId, intentId);

    const where = {
      coach_id: coachId,
      intent_id: intentId,
      entity_type: entityType,
    };

    const staged = await this.prisma.scoutIngestEntity.count({ where });
    this.assertWithinBound(coachId, intentId, staged);

    // Deterministic paged read (ordered by source_id): bounded memory + a
    // bounded number of queries regardless of roster size. Each row is
    // reconstructed idempotently, so a re-run picks up exactly where a prior
    // pass left off without minting duplicates.
    for (let skip = 0; skip < staged; skip += RECONSTRUCT_PAGE_SIZE) {
      const page = await this.prisma.scoutIngestEntity.findMany({
        where,
        select: { source_id: true, source_platform: true, payload: true },
        orderBy: { source_id: 'asc' },
        take: RECONSTRUCT_PAGE_SIZE,
        skip,
      });
      for (const row of page) {
        await this.reconstructRow(family, coachId, intentId, row);
      }
    }

    const result = await this.tally(coachId, intentId, entityType, staged);

    // PII-safe observability: correlation ids + counts only, never any staged
    // payload. A failed row is a warn so operators can alert on reconstruction
    // failures without inspecting the service_role-only ledger table directly.
    const summary = {
      intent_id: intentId,
      coach_id: coachId,
      staged: result.staged,
      reconstructed: result.reconstructed,
      skipped: result.skipped,
      failed: result.failed,
    };
    if (result.failed > 0) {
      this.logger.warn(`scout.reconstruct completed with failures ${JSON.stringify(summary)}`);
    } else {
      this.logger.log(`scout.reconstruct completed ${JSON.stringify(summary)}`);
    }

    this.analytics.capture(coachId, Events.SCOUT_RECONSTRUCT_COMPLETED, {
      intent_id: intentId,
      entity_type: entityType,
      staged: result.staged,
      reconstructed: result.reconstructed,
      skipped: result.skipped,
      failed: result.failed,
    });

    return result;
  }

  /**
   * Reject reconstruction of an intent that has not settled to a terminal
   * status. Post-settle only: reconstructing a live crawl would race the
   * still-arriving ingest and produce a partial roster.
   */
  private async assertSettled(coachId: string, intentId: string): Promise<void> {
    const importRow = await this.prisma.scoutImport.findUnique({
      where: { coach_id_intent_id: { coach_id: coachId, intent_id: intentId } },
      select: { terminal_status: true },
    });
    if (!importRow || importRow.terminal_status === null) {
      throw new ConflictException(
        'scout import intent has not settled; reconstruction is post-settle only',
      );
    }
  }

  /**
   * Reject an over-ceiling intent before any Person is minted or ledger row is
   * written. Failing closed here (rather than truncating) keeps the pass
   * all-or-nothing at the boundary and avoids partial-success ambiguity.
   */
  private assertWithinBound(coachId: string, intentId: string, staged: number): void {
    if (staged > RECONSTRUCT_MAX_ROWS) {
      this.logger.warn(
        `scout.reconstruct rejected oversized intent ${JSON.stringify({
          intent_id: intentId,
          coach_id: coachId,
          staged,
          max: RECONSTRUCT_MAX_ROWS,
        })}`,
      );
      throw new ConflictException(
        `scout import intent has ${staged} staged entities, over the ${RECONSTRUCT_MAX_ROWS} per-pass ceiling`,
      );
    }
  }

  /**
   * Reconstruct one staged row for the given family. Skips (mapper rejection)
   * write a ledger row with a reason and no target. A unique-violation (a
   * concurrent pass won the insert race) is retried once and converges
   * idempotently. Any other thrown error is isolated to this row and recorded as
   * `failed`, so sibling rows are unaffected (poison-row isolation).
   */
  private async reconstructRow(
    family: FamilyReconstructor,
    coachId: string,
    intentId: string,
    row: StagedRow,
  ): Promise<void> {
    const mapped = family.map({
      source_id: row.source_id,
      source_platform: row.source_platform,
      payload: row.payload,
    });

    if (!mapped.ok) {
      await this.writeLedger(
        family.entityType,
        coachId,
        intentId,
        row.source_id,
        RECONSTRUCT_STATUS.skipped,
        null,
        mapped.reason,
      );
      return;
    }

    try {
      await this.persistReconstructed(family, coachId, intentId, row.source_id, mapped.mapped);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A concurrent reconstruction of the same (coach, intent, source) won
        // the insert race. Both upserts are idempotent, so a single retry now
        // finds the sibling's row and converges to `reconstructed` — never a
        // spurious `failed` or a duplicate.
        try {
          await this.persistReconstructed(family, coachId, intentId, row.source_id, mapped.mapped);
          return;
        } catch (retryErr) {
          await this.writeLedger(
            family.entityType,
            coachId,
            intentId,
            row.source_id,
            RECONSTRUCT_STATUS.failed,
            null,
            summarizeError(retryErr),
          );
          return;
        }
      }
      await this.writeLedger(
        family.entityType,
        coachId,
        intentId,
        row.source_id,
        RECONSTRUCT_STATUS.failed,
        null,
        summarizeError(err),
      );
    }
  }

  /**
   * Persist one row's canonical target via the family, then mark the ledger
   * `reconstructed` atomically in the same transaction. The family owns the
   * domain write (Person or ScoutReconstructedEntity) and returns its id; the
   * engine owns the honest ledger row keyed by (coach, intent, family, source).
   */
  private async persistReconstructed(
    family: FamilyReconstructor,
    coachId: string,
    intentId: string,
    sourceId: string,
    mapped: unknown,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const targetId = await family.persist(tx, coachId, sourceId, mapped);

      await tx.scoutReconstructionLedger.upsert({
        where: {
          coach_id_intent_id_entity_type_source_id: {
            coach_id: coachId,
            intent_id: intentId,
            entity_type: family.entityType,
            source_id: sourceId,
          },
        },
        create: {
          coach_id: coachId,
          intent_id: intentId,
          entity_type: family.entityType,
          source_id: sourceId,
          status: RECONSTRUCT_STATUS.reconstructed,
          target_id: targetId,
          reason: null,
        },
        update: { status: RECONSTRUCT_STATUS.reconstructed, target_id: targetId, reason: null },
      });
    });
  }

  private async writeLedger(
    entityType: string,
    coachId: string,
    intentId: string,
    sourceId: string,
    status: string,
    targetId: string | null,
    reason: string | null,
  ): Promise<void> {
    await this.prisma.scoutReconstructionLedger.upsert({
      where: {
        coach_id_intent_id_entity_type_source_id: {
          coach_id: coachId,
          intent_id: intentId,
          entity_type: entityType,
          source_id: sourceId,
        },
      },
      create: {
        coach_id: coachId,
        intent_id: intentId,
        entity_type: entityType,
        source_id: sourceId,
        status,
        target_id: targetId,
        reason,
      },
      update: { status, target_id: targetId, reason },
    });
  }

  /** Read counts back from the durable ledger so replays are self-consistent. */
  private async tally(
    coachId: string,
    intentId: string,
    entityType: string,
    staged: number,
  ): Promise<ScoutReconstructResult> {
    const grouped = await this.prisma.scoutReconstructionLedger.groupBy({
      by: ['status'],
      where: { coach_id: coachId, intent_id: intentId, entity_type: entityType },
      _count: { _all: true },
    });
    const count = (status: string): number =>
      grouped.find((g) => g.status === status)?._count._all ?? 0;
    return {
      intent_id: intentId,
      staged,
      reconstructed: count(RECONSTRUCT_STATUS.reconstructed),
      skipped: count(RECONSTRUCT_STATUS.skipped),
      failed: count(RECONSTRUCT_STATUS.failed),
    };
  }
}

/** True for a Prisma unique-constraint violation (concurrent insert race). */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Collapse an arbitrary thrown value into a short, non-PII reason string for the
 * ledger. Never includes the staged payload — only the error class/code.
 */
function summarizeError(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return `error:Prisma.${err.code}`;
  if (err instanceof Error) return `error:${err.name}`;
  return 'error:unknown';
}
