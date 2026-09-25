import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PersonState, Prisma } from '@prisma/client';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { PrismaService } from '../prisma.service';
import {
  decodeScoutCursor,
  encodeScoutCursor,
  resolveScoutCursor,
  scoutCursorOrder,
  scoutCursorWhere,
} from './scout-cursor';
import { RECONSTRUCT_ENTITY_TYPE, RECONSTRUCT_STATUS } from './scout-reconstruct.dto';
import {
  ROSTER_BRIDGE_PENDING,
  ROSTER_DEFAULT_PAGE_SIZE,
  ROSTER_MAX_PAGE_SIZE,
  ROSTER_TARGET_KIND,
  ScoutRosterPersonDto,
  ScoutRosterResult,
} from './scout-roster.dto';

/** Prisma transaction client — the interactive-transaction handle passed to $transaction. */
type Tx = Prisma.TransactionClient;

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
 *    bounded page at a time ordered by (source_id, source_platform); the cursor
 *    is an opaque forward-only scoped v2 token naming that boundary. A legacy
 *    source-only token is still accepted and resolved to its boundary inside
 *    the read snapshot, within this (coach, intent, clients) scope only; a
 *    malformed, unresolvable, or oversized cursor / limit fails closed (400).
 *  - Erasure preserved: Deleted persons are excluded from the roster list.
 *  - Read-only, idempotent, PII-safe: no mutation, no email/billing/secret in the
 *    response or logs.
 */
@Injectable()
export class ScoutRosterService {
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
    const after = decodeScoutCursor(cursor, coachId, intentId, RECONSTRUCT_ENTITY_TYPE);

    const where = {
      coach_id: coachId,
      intent_id: intentId,
      entity_type: RECONSTRUCT_ENTITY_TYPE,
    };

    // Read the gate, the counts, and the roster page in ONE RepeatableRead
    // snapshot. All reads therefore see a single consistent moment, so the
    // accounting (staged / reconstructed / skipped / failed) can never disagree
    // with the roster rows returned for the same page even under a concurrent
    // reconstruction write. Read-only: no write conflict, no retry needed.
    const snapshot = await this.prisma.$transaction(
      async (tx) => {
        // Settled + existence + ownership gate. A ScoutImport row for THIS coach
        // whose terminal_status is non-null proves the intent belongs to the
        // caller AND has settled (post-settle reads only — a still-arriving crawl
        // would race the ingest and expose a partial roster). Unknown, another
        // tenant's intent, and not-yet-settled all collapse to a uniform 404 —
        // no existence oracle, no settle-progress oracle.
        const importRow = await tx.scoutImport.findUnique({
          where: { coach_id_intent_id: { coach_id: coachId, intent_id: intentId } },
          select: { terminal_status: true },
        });
        if (!importRow || importRow.terminal_status === null) {
          throw new NotFoundException();
        }

        // Q1: a legacy token becomes a full (source_id, source_platform)
        // boundary here — after the gate, before any count or page read, and
        // never outside this scope. Unresolvable is a 400; nothing else runs.
        const position = await resolveScoutCursor(
          tx,
          { ...where, status: RECONSTRUCT_STATUS.reconstructed },
          after,
        );

        // staged: authoritative source count. reconstructed/skipped/failed: ledger.
        const staged = await tx.scoutIngestEntity.count({ where });
        const grouped = await tx.scoutReconstructionLedger.groupBy({
          by: ['status'],
          where,
          _count: { _all: true },
        });
        // Fetch limit + 1 reconstructed ledger rows to compute has_more without a
        // second count query. Ordered by (source_id, source_platform) asc on every
        // page — the same deterministic order the reconstruction write pages in —
        // so the cursor is stable and identity ties never repeat or skip a row.
        const ledgerPage = await tx.scoutReconstructionLedger.findMany({
          where: {
            ...where,
            status: RECONSTRUCT_STATUS.reconstructed,
            ...scoutCursorWhere(position),
          },
          select: { source_id: true, source_platform: true, target_id: true, target_kind: true },
          orderBy: scoutCursorOrder(),
          take: limit + 1,
        });

        const hasMore = ledgerPage.length > limit;
        const pageRows = hasMore ? ledgerPage.slice(0, limit) : ledgerPage;
        const persons = await this.materialize(tx, coachId, pageRows);

        return { staged, grouped, hasMore, pageRows, persons };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const { staged, grouped, hasMore, pageRows, persons } = snapshot;
    const count = (status: string): number =>
      grouped.find((g) => g.status === status)?._count._all ?? 0;

    // next_cursor is anchored to the LEDGER row (not a filtered Person), so
    // paging advances deterministically even when a Deleted person is skipped
    // from the visible list. Emitted as a scoped v2 token naming the last row's
    // (source_id, source_platform).
    const last = hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1] : undefined;
    const nextCursor = last
      ? encodeScoutCursor(
          coachId,
          intentId,
          RECONSTRUCT_ENTITY_TYPE,
          last.source_id,
          last.source_platform,
        )
      : null;

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
      // S8-F: the roster is still the interim Person bridge (native contract
      // §4.1). Always true — including on an empty page — until the accepted
      // S8-D principal bridge replaces it. Not a per-row flag, not a count.
      roster_bridge_pending: ROSTER_BRIDGE_PENDING,
    };
  }

  /**
   * Join reconstructed ledger rows to their Person, preserving ledger order and
   * dropping any Deleted or missing target (erasure preserved). The Person read
   * re-asserts coach_id so a stale/forged target_id can never cross tenants. Runs
   * on the caller's transaction client so it shares the one consistent snapshot.
   *
   * S8-F: only rows whose ledger `target_kind` is NULL (legacy) or `person` are
   * Person targets. Any other kind is never joined to Person — it is dropped
   * (paging still advances because next_cursor anchors to the ledger row).
   */
  private async materialize(
    tx: Tx,
    coachId: string,
    rows: Array<{ source_id: string; target_id: string | null; target_kind: string | null }>,
  ): Promise<ScoutRosterPersonDto[]> {
    const personRows = rows.filter(
      (r) => r.target_kind === null || r.target_kind === ROSTER_TARGET_KIND,
    );
    const targetIds = personRows.map((r) => r.target_id).filter((id): id is string => id !== null);
    if (targetIds.length === 0) return [];

    const persons = await tx.person.findMany({
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
    for (const row of personRows) {
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
