import { Prisma } from '@prisma/client';
import { type MappedClient } from '../mappers/truecoach-clients.mapper';
import { type MappedEntity } from '../mappers/truecoach-entity.mapper';
import { RECONSTRUCT_FAMILY } from '../scout-reconstruct.dto';
import { buildSourceMapperRegistry } from './source-mapper-registry';

/** Prisma transaction client — the interactive-transaction handle. */
export type Tx = Prisma.TransactionClient;

/** The staged row a reconstructor consumes (a persisted ScoutIngestEntity). */
export interface StagedRow {
  readonly source_id: string;
  readonly source_platform: string;
  readonly payload: Prisma.JsonValue;
}

/** A pure map step: either a mapped domain value or a skip with a reason. */
export type MapResult<M> =
  { readonly ok: true; readonly mapped: M } | { readonly ok: false; readonly reason: string };

/**
 * One parameterized reconstruction mechanism (IMPORTER-H). A family owns two
 * responsibilities and NOTHING else: a pure/total `map` (source row → canonical
 * value or skip reason) and a `persist` (canonical value → the domain target,
 * returning its id). The engine owns everything generic around them — the
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
  persist(tx: Tx, coachId: string, sourceId: string, mapped: M): Promise<string | null>;
}

/**
 * The `source_platform` → mapper seam. A family no longer hard-wires a single
 * source's mapper; it looks the mapper up by the row's `source_platform` and
 * fails closed with the exact `unsupported_platform:<token>` skip reason when no
 * source is registered — byte-identical to the reason each mapper still returns
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
      const result = mapper.mapEntity(row);
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
 * Build the entity_type → reconstructor registry. `clients` targets `Person`;
 * every non-person family shares the generic canonical table. Billing is
 * deliberately absent — an unregistered family fails closed at the engine
 * boundary, so billing can never be reconstructed even if it were staged.
 */
export function buildFamilyRegistry(): ReadonlyMap<string, FamilyReconstructor> {
  const families: FamilyReconstructor[] = [
    clientsFamily,
    genericEntityFamily(RECONSTRUCT_FAMILY.workouts),
    genericEntityFamily(RECONSTRUCT_FAMILY.client_history),
  ];
  return new Map(families.map((family) => [family.entityType, family]));
}
