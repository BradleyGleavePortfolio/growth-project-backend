import { Prisma } from '@prisma/client';
import { RECONSTRUCT_FAMILY } from '../scout-reconstruct.dto';
import { type MappedClient, type MappedEntity } from './mapping-spec';
import { buildNativeFamilies } from './native/native-families';
import { type NativeRuleRegistry } from './native/native-rule-registry';
import { type PersistResult } from './native/persist-outcome';
import { persistPerson } from './native/person-writer';
import { type SourceMapper } from './source-mapper-registry';
import { defaultSourceRegistryProvider, type SourceRegistries } from './source-registry.provider';

export {
  LEDGER_TARGET_KIND,
  isPersistOutcome,
  type LedgerTargetKind,
  type PersistOutcome,
  type PersistResult,
} from './native/persist-outcome';

/** Prisma transaction client — the interactive-transaction handle. */
export type Tx = Prisma.TransactionClient;

/** The staged row a reconstructor consumes (a persisted ScoutIngestEntity). */
export interface StagedRow {
  readonly source_id: string;
  readonly source_platform: string;
  readonly payload: Prisma.JsonValue;
  /** Staged step token when the engine forwards it; families fall back to their own name. */
  readonly entity_type?: string;
}

/** A pure map step: either a mapped domain value or a skip with a reason. */
export type MapResult<M> =
  { readonly ok: true; readonly mapped: M } | { readonly ok: false; readonly reason: string };

/**
 * One parameterized reconstruction mechanism (IMPORTER-H). A family owns two
 * responsibilities and NOTHING else: a pure/total `map` (source row → canonical
 * value or skip reason) and a `persist` (canonical value → the domain target,
 * returning its id — or, since S8-C, a typed {@link PersistOutcome} carrying the
 * closed ledger `target_kind` with the id, or a database-determined unresolved
 * reason). The engine owns everything generic around them — the
 * settled/bounded gates, deterministic paging, the per-row transaction, the
 * P2002 retry-once convergence, poison-row isolation, and the honest ledger. So
 * adding a family is a map + persist pair, never a cloned pipeline.
 *
 * `map`/`persist` are declared as METHODS (not function-typed properties) so the
 * interface members are compared bivariantly: a `FamilyReconstructor<MappedX>`
 * is assignable to the erased `FamilyReconstructor` the registry stores, with no
 * `as`-cast at the boundary.
 */
export interface FamilyReconstructor<M = unknown> {
  readonly entityType: string;
  map(row: StagedRow): MapResult<M>;
  persist(tx: Tx, coachId: string, sourceId: string, mapped: M): Promise<PersistResult>;
}

/**
 * The `source_platform` → mapper seam. A family no longer hard-wires a single
 * source's mapper; it looks the source's data-only mapping up by the row's
 * `source_platform` (one generic interpreter over data-only specs, S8-A) and
 * fails closed with the exact `unsupported_platform:<token>` skip reason when no
 * source is registered — byte-identical to the reason the interpreter returns
 * from its own internal guard. L2a: the map is no longer built here; every
 * family takes it from the ONE `SourceRegistryProvider` (D-L0-5) — the file
 * registries for a run with no pin, the run's composed registries otherwise.
 */
type SourceMappers = ReadonlyMap<string, SourceMapper>;

/** The skip reason for a row whose `source_platform` has no registered mapper. */
function unsupportedPlatform(row: StagedRow): { readonly ok: false; readonly reason: string } {
  return { ok: false, reason: `unsupported_platform:${row.source_platform}` };
}

/**
 * `clients` — reconstruct into an invite-pending, non-login, tenant-owned roster
 * `Person` (IMPORTER-F target) through the S8-D1 typed `person` handoff: the
 * S8-C writer shape (provenance → verify → adopt a pre-D1 row → create), a
 * create-only target, and a typed outcome the engine ledgers as
 * `target_kind = person` (or `skipped` with the exact database-determined
 * `unresolved:*` reason). Identity is the provenance row keyed by the raw staged
 * source_id; the Person external_ref (coach_id, source_platform,
 * source_person_id) remains the unique key that makes a create race converge.
 */
function clientsFamily(sourceMappers: SourceMappers): FamilyReconstructor<MappedClient> {
  return {
    entityType: RECONSTRUCT_FAMILY.clients,
    map(row) {
      const mapper = sourceMappers.get(row.source_platform);
      if (mapper === undefined) return unsupportedPlatform(row);
      const result = mapper.mapClient(row);
      return result.ok ? { ok: true, mapped: result.client } : result;
    },
    persist(tx, coachId, sourceId, client) {
      return persistPerson(
        tx,
        coachId,
        { source_platform: client.sourcePlatform, source_id: sourceId },
        RECONSTRUCT_FAMILY.clients,
        client,
      );
    },
  };
}

/**
 * A non-person family (`workouts`, `client_history`) reconstructs into the ONE
 * generic canonical `ScoutReconstructedEntity` table. Identity/idempotency is
 * the tenant-scoped external_ref (coach_id, source_platform, entity_type,
 * source_id); `client_source_id` is a soft provenance link and `label` a
 * PII-minimal title. Email/billing are never mapped or written.
 */
function genericEntityFamily(
  sourceMappers: SourceMappers,
  entityType: string,
): FamilyReconstructor<MappedEntity> {
  return {
    entityType,
    map(row) {
      const mapper = sourceMappers.get(row.source_platform);
      if (mapper === undefined) return unsupportedPlatform(row);
      const result = mapper.mapEntity(entityType, row);
      return result.ok ? { ok: true, mapped: result.entity } : result;
    },
    async persist(tx, coachId, sourceId, entity) {
      const record = await tx.scoutReconstructedEntity.upsert({
        where: {
          coach_id_source_platform_entity_type_source_id: {
            coach_id: coachId,
            source_platform: entity.sourcePlatform,
            entity_type: entityType,
            source_id: sourceId,
          },
        },
        create: {
          coach_id: coachId,
          source_platform: entity.sourcePlatform,
          entity_type: entityType,
          source_id: sourceId,
          client_source_id: entity.clientSourceId,
          label: entity.label,
        },
        update: { client_source_id: entity.clientSourceId, label: entity.label },
        select: { id: true },
      });
      return record.id;
    },
  };
}

/**
 * Optional injection seam for the NATIVE families (tests / proofs); production
 * uses the repository data. Legacy families keep the repository mapper registry
 * (the provider's file registries) under this seam; {@link buildRunFamilyRegistry}
 * is the one that binds EVERY family to one run's registries.
 */
export interface FamilyRegistryOptions {
  readonly sourceMappers?: ReadonlyMap<string, SourceMapper>;
  readonly nativeRules?: NativeRuleRegistry;
}

/** The four families over a legacy mapper map and the native families' registries. */
function assembleFamilies(
  legacySourceMappers: SourceMappers,
  native: { readonly sourceMappers: SourceMappers; readonly nativeRules: NativeRuleRegistry },
): ReadonlyMap<string, FamilyReconstructor> {
  const nativeFamilies = buildNativeFamilies({
    sourceMappers: native.sourceMappers,
    nativeRules: native.nativeRules,
  });
  const families: FamilyReconstructor[] = [
    clientsFamily(legacySourceMappers),
    nativeFamilies.workouts,
    genericEntityFamily(legacySourceMappers, RECONSTRUCT_FAMILY.client_history),
    nativeFamilies.programs,
  ];
  return new Map(families.map((family) => [family.entityType, family]));
}

/**
 * Build the entity_type → reconstructor registry. `clients` targets `Person`
 * (S8-D1 typed result, ledger kind `person`); `client_history` shares the
 * generic canonical table (legacy result, kind NULL). `workouts` and `programs`
 * are the S8-C native families: the same map/persist seam, but their persist
 * returns a typed outcome — `workouts` keeps the accepted evidence write (typed
 * `scout_entity`) unless the source declares native workout rules, and
 * `programs` targets WorkoutProgram templates. Billing is deliberately absent —
 * an unregistered family fails closed at the engine boundary, so billing can
 * never be reconstructed even if it were staged.
 *
 * With no options this is exactly `buildRunFamilyRegistry(provider.files)`: the
 * repository file registries, loaded once by the one provider (D-L0-5).
 */
export function buildFamilyRegistry(
  options: FamilyRegistryOptions = {},
): ReadonlyMap<string, FamilyReconstructor> {
  const files = defaultSourceRegistryProvider().files;
  return assembleFamilies(files.sourceMappers, {
    sourceMappers: options.sourceMappers ?? files.sourceMappers,
    nativeRules: options.nativeRules ?? files.nativeRules,
  });
}

/**
 * D-L0-5: the family registry of ONE run — every family, legacy and native,
 * resolves `source_platform` through the same registries the provider resolved
 * for that run (`SourceRegistryProvider.forRun`). For a run with no pin those are
 * the file registries, so the result is what `buildFamilyRegistry()` builds.
 */
export function buildRunFamilyRegistry(
  registries: SourceRegistries,
): ReadonlyMap<string, FamilyReconstructor> {
  return assembleFamilies(registries.sourceMappers, registries);
}
