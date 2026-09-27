import { Prisma } from '@prisma/client';
import { resolveFamily } from './reconciliation/facts.service';
import type { SourceMapper } from './reconstruct/source-mapper-registry';

/**
 * S11-E — the family scope a native review reader (IMPORTER-G roster, IMPORTER-I
 * entities) selects staged and ledger rows by.
 *
 * Why: staging keeps the SOURCE TOKEN (`ScoutIngestService.ingest` stores
 * `entity_type: dto.entity_type`), the engine plans per staged
 * `(source_platform, entity_type)` group and ledgers each row under that same
 * token (`family-plan.ts` `planRun`, `scout-reconstruct.service.ts` `ledgerType`),
 * and S9 joins staged↔ledger on that wide identity. A reader that filters
 * `entity_type == <canonical family>` therefore sees NOTHING for any source whose
 * token is not literally the family name — a silent zero for a run that staged
 * rows, and a violation of NEW SOURCE → CORE DIFF = 0.
 *
 * The fix is data-only: classify every `(platform, token)` group the run staged
 * through the SAME registry the engine uses (`buildSourceMapperRegistry` +
 * `resolveFamily`, the S10-C ONE classifier). The pairs that classify to the
 * requested family become the reader's `OR` predicate; the legacy convention
 * (token == the declared family name) keeps working because `resolveFamily`
 * honours it; a group whose platform no spec registers or whose token no spec maps
 * is `unclassified` — counted and exposed, never silently zero, never served.
 *
 * Pure: no I/O, no platform slug or token literal. Bounded: the caller feeds it two
 * tenant-scoped aggregates (one per table), never a query per pair or per row.
 */

/** One `(platform, token)` aggregate row — the shape `groupBy` returns for either table. */
export interface TokenGroup {
  readonly source_platform: string;
  readonly entity_type: string;
  readonly _count: { readonly _all: number };
}

/** One staged/ledger `(platform, token)` pair that classifies to the requested family. */
export interface FamilyPair {
  readonly source_platform: string;
  readonly entity_type: string;
}

export interface FamilyScope {
  /** Sorted by (source_platform, entity_type); the reader's `OR` predicate. */
  readonly pairs: readonly FamilyPair[];
  /** Staged rows whose pair classifies to the requested family (the honest `staged`). */
  readonly staged: number;
  /**
   * Staged rows whose pair classifies to NO family (unregistered platform or unmapped
   * token). Staged rows of ANOTHER family are neither counted here nor in `staged`.
   */
  readonly unclassified: number;
}

const byPair = (a: FamilyPair, b: FamilyPair): number =>
  a.source_platform < b.source_platform
    ? -1
    : a.source_platform > b.source_platform
      ? 1
      : a.entity_type < b.entity_type
        ? -1
        : a.entity_type > b.entity_type
          ? 1
          : 0;

const pairKey = (g: FamilyPair): string => `${g.source_platform}\u0000${g.entity_type}`;

/**
 * Classify the run's staged groups (and, for pair attribution only, its ledger
 * groups) for `family`. Ledger groups contribute pairs but never counts: a ledger
 * row whose staged twin is gone is still attributed to its family so it stays
 * readable, while `staged` / `unclassified` remain the authoritative staged truth.
 */
export function classifyFamilyScope(
  sourceMappers: ReadonlyMap<string, SourceMapper>,
  family: string,
  stagedGroups: readonly TokenGroup[],
  ledgerGroups: readonly Pick<TokenGroup, 'source_platform' | 'entity_type'>[] = [],
): FamilyScope {
  const pairs = new Map<string, FamilyPair>();
  const addPair = (g: FamilyPair): void => {
    const key = pairKey(g);
    if (!pairs.has(key)) {
      pairs.set(key, { source_platform: g.source_platform, entity_type: g.entity_type });
    }
  };
  let staged = 0;
  let unclassified = 0;
  for (const g of stagedGroups) {
    const resolved = resolveFamily(sourceMappers, g.source_platform, g.entity_type);
    if (resolved === null) {
      unclassified += g._count._all;
    } else if (resolved === family) {
      staged += g._count._all;
      addPair(g);
    }
    // Another family's rows: excluded from every count of THIS scope.
  }
  for (const g of ledgerGroups) {
    if (resolveFamily(sourceMappers, g.source_platform, g.entity_type) === family) addPair(g);
  }
  return { pairs: [...pairs.values()].sort(byPair), staged, unclassified };
}

/** True when a ledger/staged row's `(platform, token)` is one of the scope's pairs. */
export function inFamilyScope(scope: FamilyScope, row: FamilyPair): boolean {
  return scope.pairs.some(
    (p) => p.source_platform === row.source_platform && p.entity_type === row.entity_type,
  );
}

/** The tenant-scoped ledger predicate over the scope's pairs; the reader ANDs status/cursor onto it. */
export type FamilyScopeWhere = Prisma.ScoutReconstructionLedgerWhereInput & {
  coach_id: string;
  intent_id: string;
  OR: FamilyPair[];
};

/**
 * `{coach_id, intent_id, OR: pairs}`. Throws on an empty scope: an empty `OR` must
 * never be dropped (Prisma would then match EVERY row of the tenant) — the caller
 * short-circuits to the truthful empty page instead.
 */
export function familyScopeWhere(
  coachId: string,
  intentId: string,
  scope: FamilyScope,
): FamilyScopeWhere {
  if (scope.pairs.length === 0) {
    throw new Error('familyScopeWhere: empty scope has no predicate');
  }
  return {
    coach_id: coachId,
    intent_id: intentId,
    OR: scope.pairs.map((p) => ({
      source_platform: p.source_platform,
      entity_type: p.entity_type,
    })),
  };
}
