import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PersonState } from '@prisma/client';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { PrismaService } from '../prisma.service';
import { RECONSTRUCT_ENTITY_TYPE, RECONSTRUCT_STATUS } from './scout-reconstruct.dto';
import {
  ROSTER_DEFAULT_PAGE_SIZE,
  ROSTER_MAX_PAGE_SIZE,
  ScoutRosterPersonDto,
  ScoutRosterResult,
} from './scout-roster.dto';

/**
 * IMPORTER-G — authoritative read bridge for the reconstructed invite-pending
 * roster (D2, Op 59). Projects one settled intent's canonical `Person` rows
 * (materialized by IMPORTER-F) joined to the honest `ScoutReconstructionLedger`.
 *
 * Guarantees:
 *  - Mechanically coach-scoped: every query filters `coach_id = caller.id`
 *    (taken from the token, never the request), and the Person join re-asserts
 *    coach_id as defense in depth — no cross-tenant row can ever surface.
 *  - No existence oracle: an unknown OR cross-tenant intent both 404 (gated on a
 *    ScoutImport row for this coach), indistinguishable from each other.
 *  - Honest accounting: `staged` is the authoritative ScoutIngestEntity source
 *    count; reconstructed/skipped/failed are read from the durable ledger, so a
 *    partial pass is visible (staged > reconstructed + skipped + failed).
 *  - Deterministic, bounded pagination: reconstructed ledger rows are read one
 *    bounded page at a time ordered by source_id; the cursor is an opaque
 *    forward-only token; a malformed cursor / oversized limit fails closed (400).
 *  - Erasure preserved: Deleted persons are excluded from the roster list.
 *  - Read-only, idempotent, PII-safe: no mutation, no email/billing/secret in the
 *    response or logs.
 */
@Injectable()
export class ScoutRosterService {
  private readonly logger = new Logger(ScoutRosterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  async getRoster(
    coachId: string,
    intentId: string,
    cursor: string | undefined,
    rawLimit: number | undefined,
  ): Promise<ScoutRosterResult> {
    const limit = rawLimit ?? ROSTER_DEFAULT_PAGE_SIZE;
    // Belt-and-braces: the DTO already bounds limit, but re-clamp here so a
    // caller that bypasses the pipe (a direct service call in a test or a future
    // internal caller) can never issue an unbounded or non-positive page read.
    if (!Number.isInteger(limit) || limit < 1 || limit > ROSTER_MAX_PAGE_SIZE) {
      throw new BadRequestException('limit out of range');
    }
    const after = decodeCursor(cursor);

    // Existence + ownership gate: a ScoutImport row for THIS coach proves the
    // intent belongs to the caller. A missing row (unknown OR another tenant's
    // intent) is a uniform 404 — no existence oracle.
    const importRow = await this.prisma.scoutImport.findUnique({
      where: { coach_id_intent_id: { coach_id: coachId, intent_id: intentId } },
      select: { id: true },
    });
    if (!importRow) throw new NotFoundException();

    const where = {
      coach_id: coachId,
      intent_id: intentId,
      entity_type: RECONSTRUCT_ENTITY_TYPE,
    };

    // staged: authoritative source count. reconstructed/skipped/failed: ledger.
    const [staged, grouped, ledgerPage] = await Promise.all([
      this.prisma.scoutIngestEntity.count({ where }),
      this.prisma.scoutReconstructionLedger.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      // Fetch limit + 1 reconstructed ledger rows to compute has_more without a
      // second count query. Ordered by source_id (asc) — the same deterministic
      // order the reconstruction write pages in — so the cursor is stable.
      this.prisma.scoutReconstructionLedger.findMany({
        where: {
          ...where,
          status: RECONSTRUCT_STATUS.reconstructed,
          ...(after !== null ? { source_id: { gt: after } } : {}),
        },
        select: { source_id: true, target_id: true },
        orderBy: { source_id: 'asc' },
        take: limit + 1,
      }),
    ]);

    const count = (status: string): number =>
      grouped.find((g) => g.status === status)?._count._all ?? 0;

    const hasMore = ledgerPage.length > limit;
    const pageRows = hasMore ? ledgerPage.slice(0, limit) : ledgerPage;

    const persons = await this.materialize(coachId, pageRows);

    // next_cursor is anchored to the LEDGER source_id (not a filtered Person), so
    // paging advances deterministically even when a Deleted person is skipped
    // from the visible list.
    const nextCursor =
      hasMore && pageRows.length > 0 ? encodeCursor(pageRows[pageRows.length - 1].source_id) : null;

    this.analytics.capture(coachId, Events.SCOUT_RECONSTRUCT_ROSTER_READ, {
      intent_id: intentId,
      entity_type: RECONSTRUCT_ENTITY_TYPE,
      returned: persons.length,
      has_more: hasMore,
    });

    return {
      intent_id: intentId,
      accounting: {
        staged,
        reconstructed: count(RECONSTRUCT_STATUS.reconstructed),
        skipped: count(RECONSTRUCT_STATUS.skipped),
        failed: count(RECONSTRUCT_STATUS.failed),
      },
      persons,
      page: { limit, next_cursor: nextCursor, has_more: hasMore },
    };
  }

  /**
   * Join reconstructed ledger rows to their Person, preserving ledger order and
   * dropping any Deleted or missing target (erasure preserved). The Person read
   * re-asserts coach_id so a stale/forged target_id can never cross tenants.
   */
  private async materialize(
    coachId: string,
    rows: Array<{ source_id: string; target_id: string | null }>,
  ): Promise<ScoutRosterPersonDto[]> {
    const targetIds = rows.map((r) => r.target_id).filter((id): id is string => id !== null);
    if (targetIds.length === 0) return [];

    const persons = await this.prisma.person.findMany({
      where: {
        id: { in: targetIds },
        coach_id: coachId,
        state: { not: PersonState.Deleted },
      },
      select: {
        id: true,
        state: true,
        source_platform: true,
        source_person_id: true,
        display_name: true,
        created_at: true,
        updated_at: true,
      },
    });

    const byId = new Map(persons.map((p) => [p.id, p]));
    const out: ScoutRosterPersonDto[] = [];
    for (const row of rows) {
      const p = row.target_id ? byId.get(row.target_id) : undefined;
      if (!p) continue;
      out.push({
        id: p.id,
        state: p.state,
        source_platform: p.source_platform,
        source_person_id: p.source_person_id,
        display_name: p.display_name,
        created_at: p.created_at.toISOString(),
        updated_at: p.updated_at.toISOString(),
      });
    }
    return out;
  }
}

/**
 * Decode an opaque forward-only cursor into the ledger source_id to page after.
 * The cursor is base64url(source_id); an unparseable or empty-decoding token is
 * a 400 (fail closed) rather than a silent full-scan-from-start.
 */
function decodeCursor(cursor: string | undefined): string | null {
  if (cursor === undefined || cursor === '') return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new BadRequestException('malformed cursor');
  }
  // base64url decoding is lenient; require a non-empty round-trippable token so a
  // garbage cursor cannot masquerade as "start from the beginning".
  if (decoded === '' || encodeCursor(decoded) !== cursor) {
    throw new BadRequestException('malformed cursor');
  }
  return decoded;
}

/** Encode a ledger source_id into an opaque forward-only cursor. */
function encodeCursor(sourceId: string): string {
  return Buffer.from(sourceId, 'utf8').toString('base64url');
}
