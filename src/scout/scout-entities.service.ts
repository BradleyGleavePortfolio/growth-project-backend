import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AnalyticsService } from '../analytics/analytics.service';
import { Events } from '../analytics/events';
import { PrismaService } from '../prisma.service';
import { type SourceMapper } from './reconstruct/source-mapper-registry';
import {
  defaultSourceRegistryProvider,
  SourceRegistryProvider,
  type RegistryDb,
} from './reconstruct/source-registry.provider';
import {
  decodeScoutCursor,
  encodeScoutCursor,
  resolveScoutCursor,
  scoutCursorOrder,
  scoutCursorWhere,
} from './scout-cursor';
import {
  ENTITIES_DEFAULT_PAGE_SIZE,
  ENTITIES_MAX_PAGE_SIZE,
  ENTITY_REVIEW_FAMILIES,
  ENTITY_TARGET_KIND,
  EntityTargetKind,
  ReconstructedEntityDto,
  ScoutEntitiesResult,
} from './scout-entities.dto';
import { classifyFamilyScope, familyScopeWhere } from './scout-family-scope';
import { RECONSTRUCT_STATUS } from './scout-reconstruct.dto';

/** Prisma transaction client — the interactive-transaction handle passed to $transaction. */
type Tx = Prisma.TransactionClient;

/** One reconstructed ledger row as the page read projects it (S8-F adds the nullable kind). */
type LedgerPageRow = {
  source_id: string;
  source_platform: string;
  entity_type: string;
  target_id: string | null;
  target_kind: string | null;
};

/**
 * S8-F: the native provenance outcomes that prove a same-coach native row was
 * produced (or found already present) by an accepted import. `unresolved` and
 * every other outcome never qualify, so an `unresolved` provenance row with a
 * NULL native_id can never dress an evidence row up as native.
 */
const NATIVE_PROVENANCE_OUTCOMES: readonly string[] = ['created', 'already_present'];

/** Minimal native projection shared by WorkoutPlan and WorkoutProgram (name only; no payload). */
type NativeRecord = { id: string; name: string; created_at: Date; updated_at: Date };

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
 *    bounded page at a time ordered by (source_id, source_platform); the cursor
 *    is an opaque forward-only scoped v2 token BOUND to (coach, intent, family,
 *    order) and naming that boundary. A legacy source-only token is still
 *    accepted and resolved inside the read snapshot within the same scope; a
 *    malformed, mismatched, or unresolvable cursor fails closed (400). The
 *    binding is a consistency guard, not an authorizer: authorization is the
 *    settled-intent gate re-run every call.
 *  - Honest page metadata, no total scan: `page_count` is the size of THIS page;
 *    the endpoint issues no unbounded count query.
 *  - S11-E family scope: staged and ledger rows carry the source's own step
 *    token, so the requested family is resolved per (source_platform, token)
 *    pair through the SAME registry the engine plans with — a token-mapped
 *    source reads exactly like the legacy token == family convention. Staged
 *    rows no spec can classify are reported in `unclassified_staged`, never a
 *    silent absence and never served.
 *  - Erasure preserved: a cascade-erased entity is simply absent from the join,
 *    so it drops from the page — there is no `Deleted` state to leak.
 *  - Read-only, idempotent, PII-safe: no mutation, no email/billing/secret in the
 *    response or logs.
 *  - Native targets (S8-F): a ledger row typed `workout_plan` / `workout_program`
 *    resolves to the coach's own live native row, and only when a same-coach
 *    native provenance row (`created` / `already_present`) vouches for that
 *    (kind, id). Legacy NULL-kind and `scout_entity` rows keep the generic
 *    evidence join unchanged. The response is additive: `target_kind` +
 *    nullable `native_id`; every established field keeps its meaning.
 */
@Injectable()
export class ScoutEntitiesService {
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
    // REQUIRED under Nest (R588-B-2): SourceRegistryModule provides it, and a missing binding
    // fails boot. The default applies only to hand-constructed instances (tests, proof workers).
    registries: SourceRegistryProvider = defaultSourceRegistryProvider(),
  ) {
    this.registries = registries;
    this.sourceMappers = this.registries.files.sourceMappers;
  }

  /**
   * The mappers THIS run's staged tokens classify through (D-L0-5): the pin's, else the
   * instance's. The pin is read on `db` — the page's snapshot transaction (R588-B-1).
   */
  private async mappersFor(
    db: RegistryDb,
    coachId: string,
    intentId: string,
  ): Promise<ReadonlyMap<string, SourceMapper>> {
    const run = await this.registries.forRun(db, coachId, intentId);
    return run.pinned === null ? this.sourceMappers : run.sourceMappers;
  }

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
    const after = decodeScoutCursor(cursor, coachId, intentId, family);

    // Tenant scope only. The family is NOT a literal `entity_type` filter on the
    // staged/ledger tables: they carry the source's own step token (S11-E), so the
    // family is resolved per (source_platform, token) pair inside the snapshot.
    const tenant = { coach_id: coachId, intent_id: intentId };

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
        // The run's registries, read inside this snapshot (after the gate: no pin read for a
        // run the caller cannot see).
        const sourceMappers = await this.mappersFor(tx, coachId, intentId);

        // S11-E: two bounded, tenant-scoped aggregates over the run's
        // (platform, token) groups — staged (the same groupBy the engine plans
        // from) and ledger — classified through the SAME registry the engine
        // uses. Neither is a full-collection total: they group a run's few
        // (platform, token) pairs, never its rows. A staged group no spec can
        // classify is counted in `unclassified_staged` and never served.
        const stagedGroups = await tx.scoutIngestEntity.groupBy({
          by: ['source_platform', 'entity_type'],
          where: tenant,
          _count: { _all: true },
        });
        const ledgerGroups = await tx.scoutReconstructionLedger.groupBy({
          by: ['source_platform', 'entity_type'],
          where: tenant,
          _count: { _all: true },
        });
        const scope = classifyFamilyScope(sourceMappers, family, stagedGroups, ledgerGroups);

        if (scope.pairs.length === 0) {
          // Nothing of this family was staged or ledgered for the run. A legacy
          // token cannot name a boundary in an empty scope — the same 400 its
          // lookup would produce; a v2 or absent cursor is the truthful empty page.
          if (after !== null && after.p === undefined) {
            throw new BadRequestException('malformed cursor');
          }
          return { scope, hasMore: false, pageRows: [] as LedgerPageRow[], entities: [] };
        }
        const where = familyScopeWhere(coachId, intentId, scope);

        // Q1: a legacy token becomes a full (source_id, source_platform)
        // boundary here — after the gate, before any page read, and never
        // outside this (coach, intent, family) scope. Unresolvable is a 400.
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
        const entities = await this.materialize(tx, coachId, family, pageRows);

        return { scope, hasMore, pageRows, entities };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const { scope, hasMore, pageRows, entities } = snapshot;

    // next_cursor is anchored to the LEDGER row (not a filtered entity), so
    // paging advances deterministically even when a cascade-erased row is dropped
    // from the visible page. Emitted as a scoped v3 token naming the last row's
    // (source_id, source_platform, entity_type).
    const last = hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1] : undefined;
    const nextCursor = last
      ? encodeScoutCursor(
          coachId,
          intentId,
          family,
          last.source_id,
          last.source_platform,
          last.entity_type,
        )
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
      unclassified_staged: scope.unclassified,
    };
  }

  /**
   * Join reconstructed ledger rows to what they target, preserving ledger order
   * and dropping any missing target (erasure preserved). Runs on the caller's
   * transaction client so it shares the one consistent snapshot.
   *
   * Dispatch is by the ledger row's `target_kind` (S8-F):
   *  - NULL (legacy) or `scout_entity` → the generic canonical
   *    `ScoutReconstructedEntity` join, unchanged: it re-asserts coach_id AND
   *    entity_type so a stale/forged target_id can never cross tenants or
   *    families. Reported with the EFFECTIVE kind `scout_entity`, native_id null.
   *  - `workout_plan` / `workout_program` → the tenant-owned native table, which
   *    must hold a same-coach, NOT archived row, AND a same-coach
   *    `ImportNativeProvenance` row with matching (native_kind, native_id) and a
   *    `created` / `already_present` outcome. Missing row, other tenant,
   *    archived, missing/mismatched provenance or a non-qualifying outcome all
   *    drop the row (fail closed). The join never touches `import_intent_id`.
   *  - a typed kind with a NULL target_id, or any unknown kind → dropped.
   * Dropped rows still advance paging because next_cursor anchors to the ledger.
   */
  private async materialize(
    tx: Tx,
    coachId: string,
    family: string,
    rows: LedgerPageRow[],
  ): Promise<ReconstructedEntityDto[]> {
    const evidenceIds: string[] = [];
    const planIds: string[] = [];
    const programIds: string[] = [];
    for (const row of rows) {
      const kind = ScoutEntitiesService.effectiveKind(row);
      if (row.target_id === null || kind === null) continue;
      if (kind === ENTITY_TARGET_KIND.scout_entity) evidenceIds.push(row.target_id);
      else if (kind === ENTITY_TARGET_KIND.workout_plan) planIds.push(row.target_id);
      else programIds.push(row.target_id);
    }
    if (evidenceIds.length + planIds.length + programIds.length === 0) return [];

    const evidence = evidenceIds.length
      ? await tx.scoutReconstructedEntity.findMany({
          where: {
            id: { in: evidenceIds },
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
        })
      : [];
    const evidenceById = new Map(evidence.map((r) => [r.id, r]));

    // Native joins: same coach, live (archived_at IS NULL), name-only projection.
    const nativeSelect = { id: true, name: true, created_at: true, updated_at: true } as const;
    const plans: NativeRecord[] = planIds.length
      ? await tx.workoutPlan.findMany({
          where: { id: { in: planIds }, coach_id: coachId, archived_at: null },
          select: nativeSelect,
        })
      : [];
    const programs: NativeRecord[] = programIds.length
      ? await tx.workoutProgram.findMany({
          where: { id: { in: programIds }, coach_id: coachId, archived_at: null },
          select: nativeSelect,
        })
      : [];
    const nativeById = new Map<string, NativeRecord>();
    for (const r of plans) nativeById.set(`${ENTITY_TARGET_KIND.workout_plan}:${r.id}`, r);
    for (const r of programs) nativeById.set(`${ENTITY_TARGET_KIND.workout_program}:${r.id}`, r);

    // Provenance: a same-coach (native_kind, native_id) row with a qualifying
    // outcome is REQUIRED for every native row served. Keyed by kind so a plan id
    // can never be vouched for by a program provenance row (or vice versa).
    const proven = new Set<string>();
    if (nativeById.size > 0) {
      const kinds: Array<{ native_kind: string; native_id: { in: string[] } }> = [];
      if (plans.length)
        kinds.push({
          native_kind: ENTITY_TARGET_KIND.workout_plan,
          native_id: { in: plans.map((r) => r.id) },
        });
      if (programs.length)
        kinds.push({
          native_kind: ENTITY_TARGET_KIND.workout_program,
          native_id: { in: programs.map((r) => r.id) },
        });
      const provenance = await tx.importNativeProvenance.findMany({
        where: {
          coach_id: coachId,
          outcome: { in: [...NATIVE_PROVENANCE_OUTCOMES] },
          OR: kinds,
        },
        select: { native_kind: true, native_id: true },
      });
      for (const p of provenance) {
        if (p.native_id !== null) proven.add(`${p.native_kind}:${p.native_id}`);
      }
    }

    const out: ReconstructedEntityDto[] = [];
    for (const row of rows) {
      const kind = ScoutEntitiesService.effectiveKind(row);
      if (row.target_id === null || kind === null) continue;
      if (kind === ENTITY_TARGET_KIND.scout_entity) {
        const r = evidenceById.get(row.target_id);
        if (!r) continue;
        out.push({
          id: r.id,
          target_kind: ENTITY_TARGET_KIND.scout_entity,
          native_id: null,
          source_platform: r.source_platform,
          entity_type: r.entity_type,
          source_id: r.source_id,
          client_source_id: r.client_source_id,
          label: r.label,
          created_at: r.created_at.toISOString(),
          updated_at: r.updated_at.toISOString(),
        });
        continue;
      }
      const key = `${kind}:${row.target_id}`;
      const native = nativeById.get(key);
      if (!native || !proven.has(key)) continue;
      out.push({
        id: native.id,
        target_kind: kind,
        native_id: native.id,
        // Provenance stays the LEDGER's (source_platform, source_id): the native
        // table carries no source identity and none is invented here.
        source_platform: row.source_platform,
        entity_type: family,
        source_id: row.source_id,
        client_source_id: null,
        label: native.name,
        created_at: native.created_at.toISOString(),
        updated_at: native.updated_at.toISOString(),
      });
    }
    return out;
  }

  /**
   * The kind a ledger row is materialized as: NULL means the pre-S8-B generic
   * evidence row (`scout_entity`); the two native kinds pass through; anything
   * else (person, a future kind, garbage) is `null` = not served here.
   */
  private static effectiveKind(row: Pick<LedgerPageRow, 'target_kind'>): EntityTargetKind | null {
    switch (row.target_kind) {
      case null:
      case ENTITY_TARGET_KIND.scout_entity:
        return ENTITY_TARGET_KIND.scout_entity;
      case ENTITY_TARGET_KIND.workout_plan:
        return ENTITY_TARGET_KIND.workout_plan;
      case ENTITY_TARGET_KIND.workout_program:
        return ENTITY_TARGET_KIND.workout_program;
      default:
        return null;
    }
  }
}
