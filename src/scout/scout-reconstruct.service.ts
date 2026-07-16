import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { PrismaService } from '../prisma.service';
import { mapTrueCoachClient, type MappedClient } from './mappers/truecoach-clients.mapper';
import {
  RECONSTRUCT_ENTITY_TYPE,
  RECONSTRUCT_MAX_ROWS,
  RECONSTRUCT_PAGE_SIZE,
  RECONSTRUCT_STATUS,
  type ScoutReconstructResult,
} from './scout-reconstruct.dto';

type StagedRow = { source_id: string; source_platform: string; payload: Prisma.JsonValue };

/**
 * IMPORTER-F — reconstruct a settled crawl intent's staged `clients` into
 * invite-pending, non-login, tenant-owned roster `Person` records (D2, Op 59).
 *
 * Guarantees:
 *  - Post-settle only: a still-running intent is rejected (no partial import).
 *  - Bounded fan-out: staged rows are counted first, an over-ceiling intent is
 *    rejected fail-closed, and the rest are read one deterministic page at a
 *    time — never the whole roster at once and never an unbounded query burst.
 *  - Idempotent: a Person is keyed on the tenant-scoped external_ref and the
 *    ledger on (coach_id, intent_id, entity_type, source_id), both upserted, so
 *    a replay mints no new rows and returns identical counts. A concurrent
 *    replay that loses the insert race (unique violation) is retried once and
 *    converges, never a spurious `failed`.
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  async reconstruct(coachId: string, intentId: string): Promise<ScoutReconstructResult> {
    await this.assertSettled(coachId, intentId);

    const where = {
      coach_id: coachId,
      intent_id: intentId,
      entity_type: RECONSTRUCT_ENTITY_TYPE,
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
        await this.reconstructRow(coachId, intentId, row);
      }
    }

    const result = await this.tally(coachId, intentId, staged);

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
      entity_type: RECONSTRUCT_ENTITY_TYPE,
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
        `scout import intent has ${staged} staged clients, over the ${RECONSTRUCT_MAX_ROWS} per-pass ceiling`,
      );
    }
  }

  /**
   * Reconstruct one staged row. Skips (mapper rejection) write a ledger row
   * with a reason and no Person. A unique-violation (a concurrent pass won the
   * insert race) is retried once and converges idempotently. Any other thrown
   * error is isolated to this row and recorded as `failed`, so sibling rows are
   * unaffected (poison-row isolation).
   */
  private async reconstructRow(coachId: string, intentId: string, row: StagedRow): Promise<void> {
    const mapped = mapTrueCoachClient({
      source_id: row.source_id,
      source_platform: row.source_platform,
      payload: row.payload,
    });

    if (!mapped.ok) {
      await this.writeLedger(
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
      await this.persistReconstructed(coachId, intentId, row.source_id, mapped.client);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A concurrent reconstruction of the same (coach, intent, source) won
        // the insert race. Both upserts are idempotent, so a single retry now
        // finds the sibling's row and converges to `reconstructed` — never a
        // spurious `failed` or a duplicate.
        try {
          await this.persistReconstructed(coachId, intentId, row.source_id, mapped.client);
          return;
        } catch (retryErr) {
          await this.writeLedger(
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
        coachId,
        intentId,
        row.source_id,
        RECONSTRUCT_STATUS.failed,
        null,
        summarizeError(err),
      );
    }
  }

  /** Mint/refresh the Person and mark the ledger `reconstructed` atomically. */
  private async persistReconstructed(
    coachId: string,
    intentId: string,
    sourceId: string,
    client: MappedClient,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const person = await tx.person.upsert({
        where: {
          coach_id_source_platform_source_person_id: {
            coach_id: coachId,
            source_platform: client.sourcePlatform,
            source_person_id: client.sourcePersonId,
          },
        },
        create: {
          coach_id: coachId,
          source_platform: client.sourcePlatform,
          source_person_id: client.sourcePersonId,
          display_name: client.displayName,
        },
        update: { display_name: client.displayName },
        select: { id: true },
      });

      await tx.scoutReconstructionLedger.upsert({
        where: {
          coach_id_intent_id_entity_type_source_id: {
            coach_id: coachId,
            intent_id: intentId,
            entity_type: RECONSTRUCT_ENTITY_TYPE,
            source_id: sourceId,
          },
        },
        create: {
          coach_id: coachId,
          intent_id: intentId,
          entity_type: RECONSTRUCT_ENTITY_TYPE,
          source_id: sourceId,
          status: RECONSTRUCT_STATUS.reconstructed,
          target_id: person.id,
          reason: null,
        },
        update: { status: RECONSTRUCT_STATUS.reconstructed, target_id: person.id, reason: null },
      });
    });
  }

  private async writeLedger(
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
          entity_type: RECONSTRUCT_ENTITY_TYPE,
          source_id: sourceId,
        },
      },
      create: {
        coach_id: coachId,
        intent_id: intentId,
        entity_type: RECONSTRUCT_ENTITY_TYPE,
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
    staged: number,
  ): Promise<ScoutReconstructResult> {
    const grouped = await this.prisma.scoutReconstructionLedger.groupBy({
      by: ['status'],
      where: { coach_id: coachId, intent_id: intentId, entity_type: RECONSTRUCT_ENTITY_TYPE },
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
