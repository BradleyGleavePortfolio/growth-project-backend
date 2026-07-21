import {
  mapTrueCoachClient,
  type MapClientResult,
  type StagedClientRow,
} from '../mappers/truecoach-clients.mapper';
import {
  mapTrueCoachEntity,
  type MapEntityResult,
  type StagedEntityRow,
} from '../mappers/truecoach-entity.mapper';
import {
  mapConformanceAlphaClient,
  mapConformanceAlphaEntity,
} from '../mappers/conformance-alpha.mapper';

/**
 * One source adapter: the per-platform pair of pure/total mappers the family
 * layer dispatches to, keyed by `source_platform`. `clients` maps to a roster
 * Person via `mapClient`; every non-person family (`workouts`, `client_history`)
 * maps to the generic canonical entity via `mapEntity`. Both are total — they
 * return an explicit skip reason rather than throwing — so the engine's
 * accounting stays exhaustive. This is the FROZEN seam adapter #2 (PR-2a) plugs
 * into: a new source is one implementing object + one registration line, with no
 * change to the engine, DTOs, contract, or schema.
 */
export interface SourceMapper {
  readonly sourcePlatform: string;
  mapClient(row: StagedClientRow): MapClientResult;
  mapEntity(row: StagedEntityRow): MapEntityResult;
}

/** TrueCoach (adapter #1) — wraps the existing mappers verbatim, unchanged. */
const trueCoachSourceMapper: SourceMapper = {
  sourcePlatform: 'truecoach',
  mapClient: mapTrueCoachClient,
  mapEntity: mapTrueCoachEntity,
};

/**
 * conformance_alpha (adapter #2) — a synthetic, non-production source registered
 * to exercise the SAME production-neutral dispatch path for deterministic
 * conformance/E2E coverage. No public connector or coach-selectable flow creates
 * `conformance_alpha` sessions today, so it is not reached in normal operation.
 * Registration itself is NOT an authorization boundary: if such a row were staged
 * within a tenant, reconstruction would map it within that tenant, exactly like
 * any registered source. Ordinary tenant/RLS scoping and the existing (default-
 * off) scout flags remain the boundaries.
 */
const conformanceAlphaSourceMapper: SourceMapper = {
  sourcePlatform: 'conformance_alpha',
  mapClient: mapConformanceAlphaClient,
  mapEntity: mapConformanceAlphaEntity,
};

/**
 * Build the `source_platform` → mapper registry: the production TrueCoach source
 * plus the synthetic `conformance_alpha` source (see above). An unregistered
 * platform is NOT found and the family layer fails it closed with the exact
 * `unsupported_platform:<token>` skip reason — byte-identical to the guard each
 * mapper still carries internally. Registration is a dispatch entry, not an
 * authorization boundary. Registering a source is a single element added to this
 * array.
 */
export function buildSourceMapperRegistry(): ReadonlyMap<string, SourceMapper> {
  const sources: SourceMapper[] = [trueCoachSourceMapper, conformanceAlphaSourceMapper];
  return new Map(sources.map((source) => [source.sourcePlatform, source]));
}
