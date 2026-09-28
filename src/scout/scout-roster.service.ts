import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PersonState, Prisma } from '@prisma/client';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { PrismaService } from '../prisma.service';
import { type SourceMapper } from './reconstruct/source-mapper-registry';
import {
  defaultSourceRegistryProvider,
  SourceRegistryProvider,
} from './reconstruct/source-registry.provider';
import {
  decodeScoutCursor,
  encodeScoutCursor,
  resolveScoutCursor,
  scoutCursorOrder,
  scoutCursorWhere,
} from './scout-cursor';
import { classifyFamilyScope, familyScopeWhere, inFamilyScope } from './scout-family-scope';
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
 *    count of the rows that classify to the roster family; reconstructed/
 *    skipped/failed are read from the durable ledger, so a partial pass is
 *    visible (staged > reconstructed + skipped + failed). S11-E: the family is
 *    resolved per staged (source_platform, token) pair through the SAME registry
 *    the engine plans with, so a token-mapped source's roster is read exactly like
 *    the legacy token == family convention; staged rows no spec can classify are
 *    reported in `unclassified` — never a silent zero, never served.
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
  /** L2a: the ONE registry provider (D-L0-5) — the same one the engine resolves through. */
  private readonly registries: SourceRegistryProvider;
  /**
   * S11-E: the `(platform, token) → family` registry of a run with NO pin — the
   * provider's file registries, the same maps the engine reads
   * (`scout-reconstruct.service.ts` `sourceMappers`). An instance field so a
   * harness that composes an injected registry for the engine can hand the
   * reader the identical one.
   */
  private readonly sourceMappers: ReadonlyMap<string, SourceMapper>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    @Optional() registries?: SourceRegistryProvider,
  ) {
    this.registries = registries ?? defaultSourceRegistryProvider();
    this.sourceMappers = this.registries.files.sourceMappers;
  }

  /** The mappers THIS run's staged tokens classify through (D-L0-5): the pin's, else the instance's. */
  private async mappersFor(
    coachId: string,
    intentId: string,
  ): Promise<ReadonlyMap<string, SourceMapper>> {
    const run = await this.registries.forRun(coachId, intentId);
    return run.pinned === null ? this.sourceMappers : run.sourceMappers;
  }

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
    const sourceMappers = await this.mappersFor(coachId, intentId);

    // Tenant scope only. The family is NOT a literal `entity_type` filter: staged
    // and ledger rows carry the source's own step token (S11-E), so the roster
    // family is resolved per (source_platform, token) pair inside the snapshot.
    const tenant = { coach_id: coachId, intent_id: intentId };

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

        // S11-E: two bounded, tenant-scoped aggregates — the run's staged
        // (platform, token) groups (the same groupBy the engine plans from) and
        // the ledger's (status, platform, token) groups — classified through the
        // SAME registry the engine uses. `staged` counts only the groups that
        // classify to the roster family; a group no spec can classify is counted
        // in `unclassified` (never a silent zero) and never served.
        const stagedGroups = await tx.scoutIngestEntity.groupBy({
          by: ['source_platform', 'entity_type'],
          where: tenant,
          _count: { _all: true },
        });
        const ledgerGroups = await tx.scoutReconstructionLedger.groupBy({
          by: ['status', 'source_platform', 'entity_type'],
          where: tenant,
          _count: { _all: true },
        });
        const scope = classifyFamilyScope(
          sourceMappers,
          RECONSTRUCT_ENTITY_TYPE,
          stagedGroups,
          ledgerGroups,
        );
        const byStatus = new Map<string, number>();
        for (const g of ledgerGroups) {
          if (!inFamilyScope(scope, g)) continue;
          byStatus.set(g.status, (byStatus.get(g.status) ?? 0) + g._count._all);
        }

        if (scope.pairs.length === 0) {
          // Nothing of this family was staged or ledgered for the run. A legacy
          // token cannot name a boundary in an empty scope — the same 400 its
          // lookup would produce; a v2 or absent cursor is the truthful empty page.
          if (after !== null && after.p === undefined) {
            throw new BadRequestException('malformed cursor');
          }
          return { scope, byStatus, hasMore: false, pageRows: [], persons: [] };
        }
        const where = familyScopeWhere(coachId, intentId, scope);

        // Q1: a legacy token becomes a full (source_id, source_platform)
        // boundary here — after the gate, before any page read, and never
        // outside this scope. Unresolvable is a 400; nothing else runs.
        const position = await resolveScoutCursor(
          tx,
          { ...where, status: RECONSTRUCT_STATUS.reconstructed },
          after,
        );

        // Fetch limit + 1 reconstructed ledger rows to compute has_more without a
        // second count query. Ordered by (source_id, source_platform, entity_type)
        // asc on every page — the ledger's unique key, so the order is total even
        // when two tokens of one platform share an id space — and the cursor names
        // one row: ties never repeat or skip a row. The cursor continuation is
        // AND-ed: the scope already owns the `OR`.
        const ledgerPage = await tx.scoutReconstructionLedger.findMany({
          where: {
            ...where,
            status: RECONSTRUCT_STATUS.reconstructed,
            ...(position === null ? {} : { AND: [scoutCursorWhere(position)] }),
          },
          select: {
            source_id: true,
            source_platform: true,
            entity_type: true,
            target_id: true,
            target_kind: true,
          },
          orderBy: scoutCursorOrder(),
          take: limit + 1,
        });

        const hasMore = ledgerPage.length > limit;
        const pageRows = hasMore ? ledgerPage.slice(0, limit) : ledgerPage;
        const persons = await this.materialize(tx, coachId, pageRows);

        return { scope, byStatus, hasMore, pageRows, persons };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const { scope, byStatus, hasMore, pageRows, persons } = snapshot;
    const count = (status: string): number => byStatus.get(status) ?? 0;

    // next_cursor is anchored to the LEDGER row (not a filtered Person), so
    // paging advances deterministically even when a Deleted person is skipped
    // from the visible list. Emitted as a scoped v3 token naming the last row's
    // (source_id, source_platform, entity_type).
    const last = hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1] : undefined;
    const nextCursor = last
      ? encodeScoutCursor(
          coachId,
          intentId,
          RECONSTRUCT_ENTITY_TYPE,
          last.source_id,
          last.source_platform,
          last.entity_type,
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
        staged: scope.staged,
        reconstructed: count(RECONSTRUCT_STATUS.reconstructed),
        skipped: count(RECONSTRUCT_STATUS.skipped),
        failed: count(RECONSTRUCT_STATUS.failed),
        unclassified: scope.unclassified,
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
