import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { PrismaService } from '../prisma.service';
import { mapTrueCoachClient } from './mappers/truecoach-clients.mapper';
import {
  RECONSTRUCT_ENTITY_TYPE,
  RECONSTRUCT_STATUS,
  type ScoutReconstructResult,
} from './scout-reconstruct.dto';

/**
 * IMPORTER-F — reconstruct a settled crawl intent's staged `clients` into
 * invite-pending, non-login, tenant-owned roster `Person` records (D2, Op 59).
 *
 * Guarantees:
 *  - Post-settle only: a still-running intent is rejected (no partial import).
 *  - Idempotent: a Person is keyed on the tenant-scoped external_ref and the
 *    ledger on (coach_id, intent_id, entity_type, source_id), both upserted, so
 *    a replay mints no new rows and returns identical counts.
 *  - Poison-row isolation: each staged row is reconstructed in its own
 *    transaction inside a try/catch; one bad row is recorded `failed` and its
 *    siblings still reconstruct.
 *  - Honest accounting: counts are read back from the durable ledger, so
 *    `staged === reconstructed + skipped + failed` always holds.
 *  - No credential is ever minted and email is never used as a key.
 */
@Injectable()
export class ScoutReconstructService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  async reconstruct(coachId: string, intentId: string): Promise<ScoutReconstructResult> {
    await this.assertSettled(coachId, intentId);

    const staged = await this.prisma.scoutIngestEntity.findMany({
      where: { coach_id: coachId, intent_id: intentId, entity_type: RECONSTRUCT_ENTITY_TYPE },
      select: { source_id: true, source_platform: true, payload: true },
    });

    for (const row of staged) {
      await this.reconstructRow(coachId, intentId, row);
    }

    const result = await this.tally(coachId, intentId, staged.length);

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
   * Reconstruct one staged row. Skips (mapper rejection) write a ledger row
   * with a reason and no Person. Any thrown error is isolated to this row and
   * recorded as `failed`, so sibling rows are unaffected (poison-row isolation).
   */
  private async reconstructRow(
    coachId: string,
    intentId: string,
    row: { source_id: string; source_platform: string; payload: Prisma.JsonValue },
  ): Promise<void> {
    try {
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

      await this.prisma.$transaction(async (tx) => {
        const person = await tx.person.upsert({
          where: {
            coach_id_source_platform_source_person_id: {
              coach_id: coachId,
              source_platform: mapped.client.sourcePlatform,
              source_person_id: mapped.client.sourcePersonId,
            },
          },
          create: {
            coach_id: coachId,
            source_platform: mapped.client.sourcePlatform,
            source_person_id: mapped.client.sourcePersonId,
            display_name: mapped.client.displayName,
          },
          update: { display_name: mapped.client.displayName },
          select: { id: true },
        });

        await tx.scoutReconstructionLedger.upsert({
          where: {
            coach_id_intent_id_entity_type_source_id: {
              coach_id: coachId,
              intent_id: intentId,
              entity_type: RECONSTRUCT_ENTITY_TYPE,
              source_id: row.source_id,
            },
          },
          create: {
            coach_id: coachId,
            intent_id: intentId,
            entity_type: RECONSTRUCT_ENTITY_TYPE,
            source_id: row.source_id,
            status: RECONSTRUCT_STATUS.reconstructed,
            target_id: person.id,
            reason: null,
          },
          update: { status: RECONSTRUCT_STATUS.reconstructed, target_id: person.id, reason: null },
        });
      });
    } catch (err) {
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

/**
 * Collapse an arbitrary thrown value into a short, non-PII reason string for the
 * ledger. Never includes the staged payload — only the error class/message.
 */
function summarizeError(err: unknown): string {
  if (err instanceof Error) return `error:${err.name}`;
  return 'error:unknown';
}
