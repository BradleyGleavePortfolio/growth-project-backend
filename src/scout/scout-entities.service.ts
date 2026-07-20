import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { PrismaService } from '../prisma.service';
import {
  ENTITIES_DEFAULT_PAGE_SIZE,
  ENTITIES_MAX_PAGE_SIZE,
  ENTITY_REVIEW_FAMILIES,
  ReconstructedEntityDto,
  ScoutEntitiesResult,
} from './scout-entities.dto';
import { RECONSTRUCT_STATUS } from './scout-reconstruct.dto';

/** Prisma transaction client — the interactive-transaction handle passed to $transaction. */
type Tx = Prisma.TransactionClient;

/** Forward-only ordering this endpoint pages in — pinned into the cursor. */
const CURSOR_ORDER = 'source_id:asc';

/**
 * IMPORTER-I — authoritative read bridge for reconstructed NON-person canonical
 * entities (D2, site-agnostic). Projects one settled intent's `workouts` /
 * `client_history` rows from the honest `ScoutReconstructionLedger` joined to the
 * generic canonical `ScoutReconstructedEntity` table (materialized by IMPORTER-H)
 * — without minting any credential, duplicating progress state, or touching the
 * clients roster contract (IMPORTER-G).
 *
 * Guarantees mirror the roster read:
 *  - Mechanically coach-scoped: every query filters `coach_id = caller.id` (from
 *    the token, never the request), and the canonical-entity join re-asserts
 *    coach_id as defense in depth — no cross-tenant row can ever surface.
 *  - No existence oracle: an unknown, cross-tenant, OR not-yet-settled intent all
 *    collapse to a single indistinguishable 404.
 *  - Deterministic, bounded pagination: reconstructed ledger rows are read one
 *    bounded page at a time ordered by source_id; the cursor is an opaque
 *    forward-only token BOUND to (coach, intent, family, order) — a malformed or
 *    mismatched cursor fails closed (400). The binding is a consistency guard,
 *    not an authorizer: authorization is the settled-intent gate re-run every
 *    call.
 *  - Honest page metadata, no total scan: `page_count` is the size of THIS page;
 *    the endpoint issues no unbounded count query.
 *  - Erasure preserved: a cascade-erased entity is simply absent from the join,
 *    so it drops from the page — there is no `Deleted` state to leak.
 *  - Read-only, idempotent, PII-safe: no mutation, no email/billing/secret in the
 *    response or logs.
 */
@Injectable()
export class ScoutEntitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
  ) {}

  async getEntities(
    coachId: string,
    intentId: string,
    family: string,
    cursor: string | undefined,
    rawLimit: number | undefined,
  ): Promise<ScoutEntitiesResult> {
    // Fail-closed on family BEFORE any read. The DTO already bounds this via
    // @IsIn, but a direct service call (test or future internal caller) that
    // bypasses the pipe must never read an unregistered or person family.
    if (!(ENTITY_REVIEW_FAMILIES as readonly string[]).includes(family)) {
      throw new BadRequestException('unsupported family');
    }

    const limit = rawLimit ?? ENTITIES_DEFAULT_PAGE_SIZE;
    // Belt-and-braces: re-clamp so a pipe-bypassing caller can never issue an
    // unbounded or non-positive page read.
    if (!Number.isInteger(limit) || limit < 1 || limit > ENTITIES_MAX_PAGE_SIZE) {
      throw new BadRequestException('limit out of range');
    }
    const after = decodeCursor(cursor, coachId, intentId, family);

    const where = {
      coach_id: coachId,
      intent_id: intentId,
      entity_type: family,
    };

    // Read the settled/ownership gate AND the entity page in ONE RepeatableRead
    // snapshot, so the rows returned can never disagree with the gate under a
    // concurrent reconstruction write. Read-only: no write conflict, no retry.
    const snapshot = await this.prisma.$transaction(
      async (tx) => {
        // Settled + existence + ownership gate. A ScoutImport row for THIS coach
        // whose terminal_status is non-null proves the intent belongs to the
        // caller AND has settled. Unknown, another tenant's intent, and
        // not-yet-settled all collapse to a uniform 404 — no existence oracle,
        // no settle-progress oracle.
        const importRow = await tx.scoutImport.findUnique({
          where: { coach_id_intent_id: { coach_id: coachId, intent_id: intentId } },
          select: { terminal_status: true },
        });
        if (!importRow || importRow.terminal_status === null) {
          throw new NotFoundException();
        }

        // Fetch limit + 1 reconstructed ledger rows to compute has_more without a
        // second count query. Ordered by source_id (asc) — the same deterministic
        // order the reconstruction write pages in — so the cursor is stable.
        const ledgerPage = await tx.scoutReconstructionLedger.findMany({
          where: {
            ...where,
            status: RECONSTRUCT_STATUS.reconstructed,
            ...(after !== null ? { source_id: { gt: after } } : {}),
          },
          select: { source_id: true, target_id: true },
          orderBy: { source_id: 'asc' },
          take: limit + 1,
        });

        const hasMore = ledgerPage.length > limit;
        const pageRows = hasMore ? ledgerPage.slice(0, limit) : ledgerPage;
        const entities = await this.materialize(tx, coachId, family, pageRows);

        return { hasMore, pageRows, entities };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const { hasMore, pageRows, entities } = snapshot;

    // next_cursor is anchored to the LEDGER source_id (not a filtered entity), so
    // paging advances deterministically even when a cascade-erased row is dropped
    // from the visible page.
    const nextCursor =
      hasMore && pageRows.length > 0
        ? encodeCursor(coachId, intentId, family, pageRows[pageRows.length - 1].source_id)
        : null;

    this.analytics.capture(coachId, Events.SCOUT_RECONSTRUCT_ENTITIES_READ, {
      intent_id: intentId,
      entity_type: family,
      returned: entities.length,
      has_more: hasMore,
    });

    return {
      intent_id: intentId,
      family,
      entities,
      page_count: entities.length,
      next_cursor: nextCursor,
    };
  }

  /**
   * Join reconstructed ledger rows to their canonical `ScoutReconstructedEntity`,
   * preserving ledger order and dropping any missing target (erasure preserved).
   * The entity read re-asserts coach_id AND entity_type so a stale/forged
   * target_id can never cross tenants or families. Runs on the caller's
   * transaction client so it shares the one consistent snapshot.
   */
  private async materialize(
    tx: Tx,
    coachId: string,
    family: string,
    rows: Array<{ source_id: string; target_id: string | null }>,
  ): Promise<ReconstructedEntityDto[]> {
    const targetIds = rows.map((r) => r.target_id).filter((id): id is string => id !== null);
    if (targetIds.length === 0) return [];

    const records = await tx.scoutReconstructedEntity.findMany({
      where: {
        id: { in: targetIds },
        coach_id: coachId,
        entity_type: family,
      },
      select: {
        id: true,
        source_platform: true,
        entity_type: true,
        source_id: true,
        client_source_id: true,
        label: true,
        created_at: true,
        updated_at: true,
      },
    });

    const byId = new Map(records.map((r) => [r.id, r]));
    const out: ReconstructedEntityDto[] = [];
    for (const row of rows) {
      const r = row.target_id ? byId.get(row.target_id) : undefined;
      if (!r) continue;
      out.push({
        id: r.id,
        source_platform: r.source_platform,
        entity_type: r.entity_type,
        source_id: r.source_id,
        client_source_id: r.client_source_id,
        label: r.label,
        created_at: r.created_at.toISOString(),
        updated_at: r.updated_at.toISOString(),
      });
    }
    return out;
  }
}

/**
 * Decode an opaque forward-only cursor into the ledger source_id to page after,
 * verifying it was minted for THIS (coach, intent, family, order). A cursor
 * whose binding does not match the current request — or that is unparseable — is
 * a 400 (fail closed), never a silent full-scan-from-start or a cross-context
 * replay. The binding is a consistency guard, not an authorizer.
 */
function decodeCursor(
  cursor: string | undefined,
  coachId: string,
  intentId: string,
  family: string,
): string | null {
  if (cursor === undefined || cursor === '') return null;
  let after: string;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    if (!isCursorPayload(parsed)) throw new Error('shape');
    if (
      parsed.c !== coachId ||
      parsed.i !== intentId ||
      parsed.f !== family ||
      parsed.o !== CURSOR_ORDER ||
      parsed.s === ''
    ) {
      throw new Error('binding');
    }
    after = parsed.s;
  } catch {
    throw new BadRequestException('malformed cursor');
  }
  // Require an exact round-trip so a garbage or tampered token cannot masquerade
  // as a valid cursor "from the beginning".
  if (encodeCursor(coachId, intentId, family, after) !== cursor) {
    throw new BadRequestException('malformed cursor');
  }
  return after;
}

/** Encode a ledger source_id into an opaque cursor bound to its read context. */
function encodeCursor(coachId: string, intentId: string, family: string, sourceId: string): string {
  const payload = { c: coachId, i: intentId, f: family, o: CURSOR_ORDER, s: sourceId };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

interface CursorPayload {
  c: string;
  i: string;
  f: string;
  o: string;
  s: string;
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.c === 'string' &&
    typeof v.i === 'string' &&
    typeof v.f === 'string' &&
    typeof v.o === 'string' &&
    typeof v.s === 'string'
  );
}
