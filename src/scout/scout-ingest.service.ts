import { BadRequestException, Injectable } from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service';
import { PrismaService } from '../prisma.service';
import {
  SCOUT_INGEST_EVENT,
  type ScoutIngestDto,
  type ScoutIngestResult,
} from './scout-ingest.dto';

@Injectable()
export class ScoutIngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  /**
   * Persist a crawl batch for `coachId`, idempotently.
   *
   * Idempotency is enforced by the (coach_id, intent_id, source_id) unique
   * index + `skipDuplicates`, which compiles to INSERT ... ON CONFLICT DO
   * NOTHING. A replayed batch (extension retry/recovery) inserts zero rows and
   * is reported as fully deduped. In-batch duplicate source_ids collapse the
   * same way, so `received` counts the envelope while `deduped` counts every
   * entity that did not produce a new row.
   */
  async ingest(coachId: string, dto: ScoutIngestDto): Promise<ScoutIngestResult> {
    const received = dto.entities.length;

    const rows = dto.entities.map((entity) => {
      const sourcePlatform = entity.payload.sourcePlatform;
      if (typeof sourcePlatform !== 'string' || sourcePlatform.length === 0) {
        throw new BadRequestException('entity payload missing sourcePlatform');
      }
      const capturedAtRaw = entity.payload.capturedAt;
      if (typeof capturedAtRaw !== 'string' || capturedAtRaw.length === 0) {
        throw new BadRequestException('entity payload missing capturedAt');
      }

      return {
        coach_id: coachId,
        intent_id: dto.intent_id,
        entity_type: dto.entity_type,
        source_id: entity.source_id,
        source_platform: sourcePlatform,
        captured_at: parseCapturedAt(capturedAtRaw),
        payload: entity.payload,
      };
    });

    const { count } = await this.prisma.scoutIngestEntity.createMany({
      data: rows,
      skipDuplicates: true,
    });

    const deduped = received - count;

    this.analytics.capture(coachId, SCOUT_INGEST_EVENT, {
      intent_id: dto.intent_id,
      entity_type: dto.entity_type,
      received,
      deduped,
    });

    return { received, deduped };
  }
}

/**
 * Parse the self-describing `capturedAt` ISO timestamp into a Date. The service
 * guarantees it is a non-empty string, but a value that is not a parseable date
 * must not fail the whole batch — provenance persistence degrades to NULL
 * rather than 500ing an otherwise valid crawl.
 */
function parseCapturedAt(value: string): Date | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}
