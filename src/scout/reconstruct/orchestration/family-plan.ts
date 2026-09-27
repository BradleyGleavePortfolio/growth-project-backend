import { RECONSTRUCT_FAMILY } from '../../scout-reconstruct.dto';
import type { FamilyReconstructor } from '../families';
import { resolveStagedFamily, type SourceMapper } from '../source-mapper-registry';

/**
 * S8-G — the pure plan of one reconstruction pass over a run's staged rows
 * (docs/decisions/2026-09-24-s8-native-contract.md §3.8).
 *
 * Input is the distinct staged `(source_platform, entity_type)` groups of one
 * (coach, intent) with their row counts, exactly as Prisma's `groupBy` returns
 * them. Each group's step token is resolved ONCE here through the source's
 * data-only mapping spec (`resolveStep`, S8-A carry-forward C2), so the engine
 * never iterates the family registry's insertion order and never maps a token
 * twice at the engine level (the native families' own `dispatch` re-evaluates
 * the same pure function with the same inputs — idempotent, not a conflict).
 */

/** One distinct staged group, as `scoutIngestEntity.groupBy({ by: ['source_platform','entity_type'] })` returns it. */
export interface StagedGroup {
  readonly source_platform: string;
  readonly entity_type: string;
  readonly _count: { readonly _all: number };
}

/** One planned (platform, token) source inside a canonical family. */
export interface PlannedSource {
  readonly source_platform: string;
  readonly token: string;
  readonly staged: number;
}

export interface PlannedFamily {
  readonly family: string;
  readonly sources: readonly PlannedSource[];
}

/** A staged group no registered spec maps to a registered family; `reason` is the exact S8-A skip reason. */
export interface UnmappedGroup extends PlannedSource {
  readonly reason: string;
}

export interface RunPlan {
  /** Canonical families with at least one staged source, in {@link RUN_FAMILY_ORDER}. */
  readonly ordered: readonly PlannedFamily[];
  /** Groups the pass ledgers `skipped` with their reason, in (platform, token) order. */
  readonly unmapped: readonly UnmappedGroup[];
}

/**
 * Contract §3.8 order: `clients → programs → workouts (coach templates) → client-owned
 * families`. `programs` before `workouts` is load-bearing: program-day plans resolve their
 * parent through provenance and stay `relationship_pending` when the program has not landed.
 * This is deliberately NOT the `RECONSTRUCT_FAMILY` declaration order nor the registry's
 * insertion order.
 */
export const RUN_FAMILY_ORDER = [
  RECONSTRUCT_FAMILY.clients,
  RECONSTRUCT_FAMILY.programs,
  RECONSTRUCT_FAMILY.workouts,
  RECONSTRUCT_FAMILY.client_history,
] as const;

const bySource = (a: PlannedSource, b: PlannedSource): number =>
  a.source_platform < b.source_platform
    ? -1
    : a.source_platform > b.source_platform
      ? 1
      : a.token < b.token
        ? -1
        : a.token > b.token
          ? 1
          : 0;

/**
 * Pure: no I/O. A group whose token resolves (`ok`) to a family the registry holds is planned
 * into that family; every other group is unmapped with the reason `resolveStagedFamily`
 * returned (`unsupported_platform:<platform>` or `unresolved_family:<token>`), or
 * `unresolved_family:<token>` when the spec names a family the registry does not register.
 * Families with no staged rows are omitted — a family is never invented.
 */
export function planRun(
  staged: readonly StagedGroup[],
  mappers: ReadonlyMap<string, SourceMapper>,
  registry: ReadonlyMap<string, FamilyReconstructor>,
): RunPlan {
  const planned = new Map<string, PlannedSource[]>();
  const unmapped: UnmappedGroup[] = [];
  for (const group of staged) {
    const source: PlannedSource = {
      source_platform: group.source_platform,
      token: group.entity_type,
      staged: group._count._all,
    };
    const step = resolveStagedFamily(mappers, group.source_platform, group.entity_type);
    if (!step.ok) {
      unmapped.push({ ...source, reason: step.reason });
      continue;
    }
    if (!registry.has(step.family)) {
      unmapped.push({ ...source, reason: `unresolved_family:${group.entity_type}` });
      continue;
    }
    const sources = planned.get(step.family) ?? [];
    sources.push(source);
    planned.set(step.family, sources);
  }
  const ordered: PlannedFamily[] = [];
  for (const family of RUN_FAMILY_ORDER) {
    const sources = planned.get(family);
    if (sources !== undefined) ordered.push({ family, sources: [...sources].sort(bySource) });
  }
  return { ordered, unmapped: unmapped.sort(bySource) };
}
