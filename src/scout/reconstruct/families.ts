import { Prisma } from '@prisma/client';
import { RECONSTRUCT_FAMILY } from '../scout-reconstruct.dto';
import { type MappedClient, type MappedEntity } from './mapping-spec';
import { buildNativeFamilies } from './native/native-families';
import { buildNativeRuleRegistry, type NativeRuleRegistry } from './native/native-rule-registry';
import { type PersistResult } from './native/persist-outcome';
import { buildSourceMapperRegistry, type SourceMapper } from './source-mapper-registry';

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
 * `source_platform` (one generic interpreter over `./sources/*.json`, S8-A) and
 * fails closed with the exact `unsupported_platform:<token>` skip reason when no
 * source is registered — byte-identical to the reason the interpreter returns
 * from its own internal guard. Built once at module load; the map is read-only.
 */
const sourceMapperRegistry = buildSourceMapperRegistry();

/** The skip reason for a row whose `source_platform` has no registered mapper. */
function unsupportedPlatform(row: StagedRow): { readonly ok: false; readonly reason: string } {
  return { ok: false, reason: `unsupported_platform:${row.source_platform}` };
}

/**
 * `clients` — byte-identical to IMPORTER-F: reconstruct into an invite-pending,
 * non-login, tenant-owned roster `Person`. Identity/idempotency is the
 * tenant-scoped external_ref (coach_id, source_platform, source_person_id).
 */
const clientsFamily: FamilyReconstructor<MappedClient> = {
  entityType: RECONSTRUCT_FAMILY.clients,
  map(row) {
    const mapper = sourceMapperRegistry.get(row.source_platform);
    if (mapper === undefined) return unsupportedPlatform(row);
    const result = mapper.mapClient(row);
    return result.ok ? { ok: true, mapped: result.client } : result;
  },
  async persist(tx, coachId, _sourceId, client) {
    const person = await tx.person.upsert({
      where: {
        coach_id_source_platform_source_person_id: {
          coach_id: coachId,
          source_platform: client.sourcePlatform,
          source_person_id: client.sourcePersonId,
        },
      },
      create: {
        coach_id: coachId,
        source_platform: client.sourcePlatform,
        source_person_id: client.sourcePersonId,
        display_name: client.displayName,
      },
      update: { display_name: client.displayName },
      select: { id: true },
    });
    return person.id;
  },
};

/**
 * A non-person family (`workouts`, `client_history`) reconstructs into the ONE
 * generic canonical `ScoutReconstructedEntity` table. Identity/idempotency is
 * the tenant-scoped external_ref (coach_id, source_platform, entity_type,
 * source_id); `client_source_id` is a soft provenance link and `label` a
 * PII-minimal title. Email/billing are never mapped or written.
 */
function genericEntityFamily(entityType: string): FamilyReconstructor<MappedEntity> {
  return {
    entityType,
    map(row) {
      const mapper = sourceMapperRegistry.get(row.source_platform);
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
 * uses the repository data. Legacy families keep the repository mapper registry.
 */
export interface FamilyRegistryOptions {
  readonly sourceMappers?: ReadonlyMap<string, SourceMapper>;
  readonly nativeRules?: NativeRuleRegistry;
}

/**
 * Build the entity_type → reconstructor registry. `clients` targets `Person`
 * (legacy result, ledger kind NULL); `client_history` shares the generic
 * canonical table (legacy result, kind NULL). `workouts` and `programs` are the
 * S8-C native families: the same map/persist seam, but their persist returns a
 * typed outcome — `workouts` keeps the accepted evidence write (typed
 * `scout_entity`) unless the source declares native workout rules, and
 * `programs` targets WorkoutProgram templates. Billing is deliberately absent —
 * an unregistered family fails closed at the engine boundary, so billing can
 * never be reconstructed even if it were staged.
 */
export function buildFamilyRegistry(
  options: FamilyRegistryOptions = {},
): ReadonlyMap<string, FamilyReconstructor> {
  const native = buildNativeFamilies({
    sourceMappers: options.sourceMappers ?? sourceMapperRegistry,
    nativeRules: options.nativeRules ?? buildNativeRuleRegistry(),
  });
  const families: FamilyReconstructor[] = [
    clientsFamily,
    native.workouts,
    genericEntityFamily(RECONSTRUCT_FAMILY.client_history),
    native.programs,
  ];
  return new Map(families.map((family) => [family.entityType, family]));
}
